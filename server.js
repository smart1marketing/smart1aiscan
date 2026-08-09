/**
 * Smart 1 Marketing — AI Visibility Scan (v2, Insites-powered)
 *
 * Lead-funnel microservice. Primary analysis engine is the Insites Audit
 * API (real SEO / local / AI-visibility audit data). If INSITES_API_KEY is
 * not configured or an Insites request fails, it falls back automatically
 * to the built-in Cheerio scanner so the funnel never goes down.
 *
 * Flow:
 *   POST /api/scan            → kicks off audit, returns { scanId } immediately
 *   GET  /api/scan/:id/status → frontend polls; returns teaser data when ready
 *   POST /api/unlock          → lead capture; returns full report; fires
 *                               Smart 1 Suite webhook
 *
 * Deploy target: Render (Web Service, Node).
 */

const express = require("express");
const cheerio = require("cheerio");
const OpenAI = require("openai");
const cloudinary = require("cloudinary").v2;
const PDFDocument = require("pdfkit");
const { Readable } = require("stream");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- Config ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SMART1_WEBHOOK_URL = process.env.SMART1_WEBHOOK_URL || "";
const SMART1_WEBHOOK_TOKEN = process.env.SMART1_WEBHOOK_TOKEN || "";
const CALENDAR_URL = process.env.CALENDAR_URL || "https://smart1marketing.com/book-a-call";

// Conversion copy — all overridable without touching code
const CTA_LABEL = process.env.CTA_LABEL || "Get My Free Action Plan";
const TRUST_LINE =
  process.env.TRUST_LINE || "No obligation — just a clear picture of where you stand.";
const SAMPLE_REPORT_URL = process.env.SAMPLE_REPORT_URL || "";

// Cloudinary — stores the generated PDF report AND the full raw Insites
// audit payload, so both are durably retrievable later (not just for the
// lifetime of the in-memory scan cache). Report delivery email itself is
// NOT sent from this app — the PDF/data URLs ride along in the Smart 1
// Suite webhook payload, and Smart 1 Suite's own automation sends the email.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "";
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "";
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "";
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || "smart1-ai-visibility-reports";

// How long a stored Insites scan can be reused for a repeat visit to the
// same domain before we spend a fresh Insites credit. This is our OWN
// cache (in Cloudinary), independent of Insites' own `check_for_existing`
// reuse. Default 30 days — long enough to meaningfully cut credit spend on
// repeat/return visitors, short enough that the data isn't stale. Set to 0
// to disable reuse entirely and always run a fresh audit.
const INSITES_CACHE_TTL_DAYS = Number(process.env.INSITES_CACHE_TTL_DAYS || 30);
const INSITES_CACHE_TTL_MS = INSITES_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

// Troubleshooting panel — see /debug.html. The log endpoint is disabled
// entirely (404, not just 403) unless a token is set, so an un-configured
// deploy doesn't expose anything.
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || "";

const cloudinaryConfigured = !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });
}

// Insites
const INSITES_API_KEY = process.env.INSITES_API_KEY || "";
const INSITES_API_BASE = process.env.INSITES_API_BASE || "https://api.insites.com/api/v1";
// How long the server-side poller waits for an Insites audit before falling
// back to the built-in scanner. Real-world audits have taken well over 90s
// for some sites — rather than truncate to the lower-quality fallback
// early, we let Insites run its full course and set honest "3-4 minutes"
// expectations up front instead. Worst case: this + ~15-20s fallback.
const INSITES_MAX_WAIT_MS = Number(process.env.INSITES_MAX_WAIT_MS || 200000);
const INSITES_POLL_INTERVAL_MS = 5000;

const FETCH_TIMEOUT_MS = 10000;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// In-memory scan store. Swap for Redis/a DB before scaling past a single
// Render instance or if scans must survive restarts.
const scans = new Map();
const competitorScans = new Map();
const SCAN_TTL_MS = 60 * 60 * 1000;

// ---- Troubleshooting log (in-memory ring buffer, see /debug.html) --------
// Survives independently of the scans/competitorScans TTL so you can see
// what happened even after a scan's own record has expired or been
// deleted post-unlock. Resets on every deploy/restart (in-memory only —
// this is a live troubleshooting aid, not an audit trail; Cloudinary is
// the durable record).
const MAX_LOG_ENTRIES = 300;
const activityLog = [];

function logEvent(level, type, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level, // "info" | "warn" | "error"
    type, // e.g. "scan_start", "insites_timeout", "webhook_sent"
    message,
    meta: meta || null,
  };
  activityLog.push(entry);
  if (activityLog.length > MAX_LOG_ENTRIES) activityLog.shift();

  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[${type}] ${message}`);
  return entry;
}

/** Masks an email for logging so PII doesn't sit in the in-memory ring
 *  buffer any longer than necessary — keeps enough to be useful (domain,
 *  first character) without exposing the full address. */
function maskEmail(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) return null;
  const [user, domain] = email.split("@");
  return `${user[0] || ""}***@${domain}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of scans) {
    if (now - s.createdAt > SCAN_TTL_MS) scans.delete(id);
  }
  for (const [id, s] of competitorScans) {
    if (now - s.createdAt > SCAN_TTL_MS) competitorScans.delete(id);
  }
}, 5 * 60 * 1000);

// ---- Generic helpers -------------------------------------------------------

function urlError(message) {
  const err = new Error(message);
  err.userFacing = true;
  return err;
}

/**
 * Turns whatever a real person actually types or pastes into a scannable
 * URL. People will enter this in every format imaginable — this recovers
 * from the common ones rather than rejecting them:
 *   "example.com"              -> https://example.com
 *   "www.example.com"          -> https://www.example.com
 *   "HTTPS://Example.COM"      -> https://example.com
 *   "  example.com  "          -> https://example.com
 *   "\"example.com\""          -> https://example.com   (pasted with quotes)
 *   "www . example . com"      -> https://www.example.com (stray spaces)
 *   "//example.com"            -> https://example.com   (protocol-relative)
 *   "example.com."             -> https://example.com   (trailing period)
 * Genuinely invalid input (no dot, empty, wrong protocol) throws a clear,
 * user-facing message rather than a generic one.
 */
function normalizeUrl(input) {
  let url = String(input || "").trim();

  // Strip wrapping quotes from copy/paste.
  url = url.replace(/^['"]+|['"]+$/g, "");

  // A domain never legitimately contains whitespace — remove it rather
  // than reject, since this is almost always a stray-space typo
  // ("www . example . com") or a voice-to-text artifact.
  url = url.replace(/\s+/g, "");

  // Strip a leading protocol-relative slash pair ("//example.com").
  url = url.replace(/^\/\/+/, "");

  // Strip a trailing sentence-ending period ("example.com.").
  url = url.replace(/\.+$/, "");

  if (!url) {
    throw urlError("Please enter a website address.");
  }

  // Add https:// only if no protocol is present at all. If some other
  // protocol was given (ftp://, mailto:, etc.) we don't silently rewrite
  // it — the parse below reports that clearly instead.
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw urlError("That doesn't look like a valid website address. Just the domain, like yourbusiness.com.");
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw urlError("Please enter a regular web address, like yourbusiness.com — no need for http:// or https://.");
  }

  // Require at least one dot — catches "example" / stray single-word typos
  // before they burn a fetch/audit attempt on a non-domain.
  if (!parsed.hostname.includes(".")) {
    throw urlError("Please enter a full domain, like yourbusiness.com.");
  }

  return parsed;
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Smart1AIVisibilityBot/2.0 (+https://smart1marketing.com; site-readiness-scan)",
        ...(opts.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

async function safeText(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return { ok: false, status: res.status, body: "" };
    return { ok: true, status: res.status, body: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, body: "", error: e.message };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tierForScore(score) {
  if (score < 25) return "Critical";
  if (score < 50) return "Competitive";
  if (score < 75) return "Strong";
  return "Dominant";
}

// ---- Engine 1: Insites Audit API ------------------------------------------

async function insitesRequest(path, opts = {}) {
  const res = await fetchWithTimeout(`${INSITES_API_BASE}${path}`, {
    ...opts,
    headers: {
      "api-key": INSITES_API_KEY,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

/** Kick off an Insites audit. Returns reportId, or existing report data on 303. */
async function insitesStartAudit(url, extra = {}) {
  const payload = {
    url,
    priority: "normal",
    // Reuse a recent audit if this hostname was scanned in the last 24h —
    // saves audit credits on repeat visitors.
    check_for_existing: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    ...extra,
  };
  const { status, body } = await insitesRequest("/report", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (status === 202 && body && body.reportId) {
    return { reportId: body.reportId, existing: false };
  }
  if (status === 303 && body && (body.reportId || body.report_id)) {
    return { reportId: body.reportId || body.report_id, existing: true };
  }
  const msg = (body && (body.error || body.message)) || `Insites returned HTTP ${status}`;
  const err = new Error(msg);
  err.insitesStatus = status;
  throw err;
}

/** Fetch a completed Insites report. Returns null while still running. */
async function insitesFetchReport(reportId) {
  const { status, body } = await insitesRequest(`/report/${reportId}`);
  if (status === 200 && body && body.report) return body.report;
  if (status === 202) return null; // still running
  const err = new Error(`Insites report fetch failed (HTTP ${status})`);
  err.insitesStatus = status;
  throw err;
}

/** Fetch the LLM-optimised payload (best input for the OpenAI narrative). */
async function insitesFetchLLMReport(reportId) {
  try {
    const { status, body } = await insitesRequest(`/llm/report-fetch/${reportId}`);
    if (status === 200 && body && body.report) return body.report;
  } catch (_) {
    /* optional enrichment — fine to skip */
  }
  return null;
}

/**
 * Map an Insites report (structure varies by account config) into our
 * normalized scan shape. Defensive: every field is optional.
 */
function mapInsitesReport(report, url) {
  const g = (path, dflt = undefined) => {
    try {
      return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), report) ?? dflt;
    } catch (_) {
      return dflt;
    }
  };

  const score = Math.max(0, Math.min(100, Math.round(Number(g("overall_score", 0)) || 0)));
  const pages = Number(g("page_count.pages_discovered_count", 0)) || 0;
  const findings = [];

  const missingTitles = Number(g("page_titles_and_descriptions.pages_missing_title_count", 0)) || 0;
  const missingDescs =
    Number(g("page_titles_and_descriptions.pages_missing_description_count", 0)) || 0;
  if (missingTitles > 0)
    findings.push(`${missingTitles} page(s) are missing title tags — invisible labels to both search and AI engines.`);
  if (missingDescs > 0)
    findings.push(`${missingDescs} page(s) are missing meta descriptions.`);

  const isMobile = g("mobile.is_mobile");
  if (isMobile === false)
    findings.push("The site isn't mobile-optimized — a direct ranking and trust penalty.");

  const loadTime = Number(g("website_speed.average_homepage_load_time_seconds", 0)) || 0;
  if (loadTime > 3)
    findings.push(`Homepage takes ~${loadTime.toFixed(1)}s to load — slow pages get crawled less and cited less.`);

  const reviewsCount = Number(g("reviews.reviews_found_count", 0)) || 0;
  if (reviewsCount < 5)
    findings.push("Very few online reviews found — AI engines lean heavily on review signals when recommending local businesses.");

  const detectedName = g("local_presence.detected_name");
  const detectedAddress = g("local_presence.detected_address");
  const detectedPhone = g("local_presence.detected_phone");
  if (!detectedName || !detectedAddress || !detectedPhone)
    findings.push("Incomplete business identity (name/address/phone) detected across the web — weak local entity signal for AI engines.");

  const daysSinceUpdate = Number(g("last_updated.days_since_update", 0)) || 0;
  if (daysSinceUpdate > 180)
    findings.push(`Content hasn't been updated in ~${Math.round(daysSinceUpdate / 30)} months — stale sites lose AI citation trust.`);

  const wordCount = Number(g("amount_of_content.total_word_count", 0)) || 0;
  if (wordCount > 0 && wordCount < 1000)
    findings.push("Thin overall content — limited raw material for AI engines to extract and cite.");

  const hasAnalytics = !!g("analytics.analytics_tool");
  if (!hasAnalytics)
    findings.push("No analytics tool detected — no way to measure or improve AI/search traffic.");

  const backlinks = Number(g("incoming_links.total_backlinks", 0)) || 0;

  if (findings.length === 0) {
    findings.push("Fundamentals look solid — the opportunity is in AI-specific structure (schema depth, llms.txt, conversational content) competitors haven't built yet.");
  }

  return {
    engine: "insites",
    url,
    domain: report.domain || normalizeUrl(url).hostname,
    score,
    tier: tierForScore(score),
    signals: {
      pagesDiscovered: pages,
      analysedPages: Number(report.analysed_page_count || 0),
      mobileOptimized: isMobile,
      homepageLoadSeconds: loadTime || null,
      reviewsFound: reviewsCount,
      totalBacklinks: backlinks,
      totalWordCount: wordCount,
      daysSinceContentUpdate: daysSinceUpdate || null,
      analyticsTool: g("analytics.analytics_tool") || null,
      detectedName: detectedName || null,
      detectedAddress: detectedAddress || null,
      detectedPhone: detectedPhone || null,
      missingTitleCount: missingTitles,
      missingDescriptionCount: missingDescs,
      domainAgeDays: Number(g("domain_age.domain_age_days", 0)) || null,
    },
    findings,
    insitesReportId: report.report_id || null,
    raw: report, // full payload rides along into the CRM webhook
  };
}

// ---- Engine 2: built-in Cheerio fallback ----------------------------------

function extractSchemaTypes($) {
  const types = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const graph = node["@graph"] || [node];
        for (const gnode of graph) {
          const t = gnode && gnode["@type"];
          if (!t) continue;
          (Array.isArray(t) ? t : [t]).forEach((x) => types.add(String(x)));
        }
      }
    } catch (_) {}
  });
  return types;
}

async function fallbackScan(targetUrl) {
  const parsed = normalizeUrl(targetUrl);
  const origin = parsed.origin;

  const [homepage, robots, sitemap, llmsTxt] = await Promise.all([
    safeText(parsed.toString()),
    safeText(origin + "/robots.txt"),
    safeText(origin + "/sitemap.xml"),
    safeText(origin + "/llms.txt"),
  ]);

  if (!homepage.ok) {
    const err = new Error(
      `Couldn't reach ${parsed.toString()} (status ${homepage.status || "unknown"}). Check the URL and try again.`
    );
    err.userFacing = true;
    throw err;
  }

  const $ = cheerio.load(homepage.body);
  const schemaTypes = extractSchemaTypes($);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").length : 0;

  const hasFAQ = schemaTypes.has("FAQPage");
  const hasHowTo = schemaTypes.has("HowTo");
  const hasLocalBusiness = [...schemaTypes].some((t) =>
    /LocalBusiness|Organization|.*Business$/.test(t)
  );
  const hasNAP = /(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/.test(bodyText);
  const title = $("title").first().text().trim();
  const metaDesc = $('meta[name="description"]').attr("content") || "";
  const sitemapUrlCount = sitemap.ok ? (sitemap.body.match(/<loc>/gi) || []).length : 0;
  const robotsBlocksAll =
    robots.ok && /User-agent:\s*\*\s*[\r\n]+\s*Disallow:\s*\/\s*$/im.test(robots.body);

  let score = 0;
  const findings = [];

  let schemaScore = 0;
  if (hasFAQ) schemaScore += 12;
  if (hasHowTo) schemaScore += 6;
  if (hasLocalBusiness) schemaScore += 7;
  score += Math.min(schemaScore, 25);
  if (!hasFAQ && !hasHowTo)
    findings.push("No FAQ or HowTo schema detected — AI engines have no conversational, machine-readable modules to extract for direct answers.");

  if (llmsTxt.ok) score += 15;
  else findings.push("No llms.txt file found — there's no explicit policy telling LLMs how to understand, index, and cite the business.");

  if (sitemap.ok && sitemapUrlCount > 0) score += 10;
  else findings.push("No reachable sitemap.xml — this slows discovery and indexing of new pages.");

  if (title) score += 5;
  if (metaDesc) score += 5;
  if (!title || !metaDesc) findings.push("Missing or thin title/meta description tags on the homepage.");

  if (hasNAP) score += 5;
  if (hasLocalBusiness) score += 5;
  if (!hasNAP) findings.push("No clear phone/contact pattern found on the homepage — weak local entity signal.");

  if (wordCount > 1200) score += 15;
  else if (wordCount > 600) score += 9;
  else if (wordCount > 250) score += 4;
  else findings.push("Homepage content is thin — limited raw material for AI engines to draw from.");

  if (robots.ok && !robotsBlocksAll) score += 15;
  else if (!robots.ok) score += 7;
  else findings.push("robots.txt appears to block crawling site-wide.");

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    engine: "builtin",
    url: parsed.toString(),
    domain: parsed.hostname,
    score,
    tier: tierForScore(score),
    signals: {
      hasFAQSchema: hasFAQ,
      hasHowToSchema: hasHowTo,
      hasLocalBusinessSchema: hasLocalBusiness,
      hasNAP,
      hasTitle: !!title,
      hasMetaDescription: !!metaDesc,
      wordCount,
      sitemapFound: sitemap.ok,
      sitemapUrlCount,
      pagesDiscovered: sitemapUrlCount, // proxy for package sizing
      llmsTxtFound: llmsTxt.ok,
      robotsBlocksAll,
    },
    findings,
    insitesReportId: null,
    raw: null,
  };
}

// ---- Domain-keyed scan cache (Cloudinary) ----------------------------------
// Budgets Insites credits by reusing a prior scan of the same domain when
// it's recent enough. This is separate from Insites' own check_for_existing
// (which is short-lived and depends on Insites' retention) — this is our
// durable cache, keyed by a deterministic public_id so we can look it up by
// domain alone. Stored as a raw JSON resource that overwrites in place, so
// there's exactly one cache entry per domain, always holding the latest.

function cacheDomainKey(hostname) {
  // Deterministic, filesystem/URL-safe key. Strips a leading www. so
  // "example.com" and "www.example.com" share one cache entry. Includes
  // the .json extension because Cloudinary stores raw resources with the
  // extension as part of the public_id — read and write must match exactly.
  const bare = String(hostname).toLowerCase().replace(/^www\./, "");
  const safe = bare.replace(/[^a-z0-9.-]/g, "_");
  return `${CLOUDINARY_FOLDER}/scan-cache/${safe}.json`;
}

/**
 * Look for a cached scan of this hostname that's still within the TTL.
 * Returns the stored scan object (ready to hand back like a fresh one) or
 * null. Never throws — a cache miss or any Cloudinary hiccup just means we
 * fall through to a real audit.
 */
async function readScanCache(hostname) {
  if (!cloudinaryConfigured || INSITES_CACHE_TTL_MS <= 0) return null;
  const publicId = cacheDomainKey(hostname);
  try {
    // Resolve the raw resource's URL, then fetch its JSON body.
    const resource = await cloudinary.api.resource(publicId, { resource_type: "raw" });
    if (!resource || !resource.secure_url) return null;

    const res = await fetchWithTimeout(resource.secure_url, { timeoutMs: 8000 });
    if (!res.ok) return null;
    const cached = await res.json();

    const cachedAt = cached && cached.cachedAt ? new Date(cached.cachedAt).getTime() : 0;
    const ageMs = Date.now() - cachedAt;
    if (!cachedAt || ageMs > INSITES_CACHE_TTL_MS) {
      return null; // expired — fall through to a fresh audit
    }
    if (!cached.scan) return null;

    cached.scan._cacheAgeMs = ageMs; // for logging
    return cached.scan;
  } catch (e) {
    // resource-not-found (first time we've seen this domain) lands here too
    return null;
  }
}

/** Store a completed scan as this domain's cache entry (overwrites in place). */
async function writeScanCache(hostname, scan) {
  if (!cloudinaryConfigured || INSITES_CACHE_TTL_MS <= 0) return;
  const publicId = cacheDomainKey(hostname);
  try {
    const payload = JSON.stringify({
      cachedAt: new Date().toISOString(),
      hostname,
      scan,
    });
    await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: "raw", public_id: publicId, overwrite: true, invalidate: true, tags: ["scan-cache"] },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      Readable.from(Buffer.from(payload, "utf8")).pipe(stream);
    });
  } catch (e) {
    logEvent("warn", "cache_write_error", `Couldn't cache scan for ${hostname}: ${e.message}`, { hostname, error: e.message });
  }
}

// ---- Orchestration: run a scan (async, updates the scans map) --------------

async function executeScan(scanId, url) {
  const entry = scans.get(scanId);
  if (!entry) return;
  const startedAt = Date.now();

  const finish = (scan) => {
    entry.status = "complete";
    entry.scan = scan;
    entry.completedAt = Date.now();
    logEvent(
      "info",
      "scan_complete",
      `${scan.domain} — ${scan.engine} engine, score ${scan.score}, ${entry.completedAt - startedAt}ms`,
      { scanId, domain: scan.domain, engine: scan.engine, score: scan.score, durationMs: entry.completedAt - startedAt }
    );
  };
  const fail = (message) => {
    entry.status = "error";
    entry.error = message;
    logEvent("error", "scan_error", `${url} failed after ${Date.now() - startedAt}ms: ${message}`, {
      scanId,
      url,
      durationMs: Date.now() - startedAt,
    });
  };

  logEvent("info", "scan_start", `Scan requested for ${url}`, { scanId, url });

  // Try Insites first
  if (INSITES_API_KEY) {
    try {
      const parsed = normalizeUrl(url);

      // Budget check: reuse a recent stored scan of this domain before
      // spending an Insites credit.
      const cached = await readScanCache(parsed.hostname);
      if (cached) {
        const ageDays = Math.round((cached._cacheAgeMs || 0) / (24 * 60 * 60 * 1000));
        delete cached._cacheAgeMs;
        cached.fromCache = true;
        entry.insitesReportId = cached.insitesReportId || null;
        logEvent("info", "cache_hit", `Reused cached scan for ${parsed.hostname} (~${ageDays}d old) — no Insites credit spent.`, {
          scanId,
          domain: parsed.hostname,
          ageDays,
        });
        return finish(cached);
      }

      // Insites rejects URLs with paths — send hostname only
      const { reportId } = await insitesStartAudit(parsed.hostname);
      entry.insitesReportId = reportId;
      logEvent("info", "insites_start", `Insites audit started for ${parsed.hostname} (report ${reportId})`, {
        scanId,
        reportId,
      });

      const deadline = Date.now() + INSITES_MAX_WAIT_MS;
      while (Date.now() < deadline) {
        const report = await insitesFetchReport(reportId);
        if (report) {
          const scan = mapInsitesReport(report, parsed.toString());
          // grab the LLM-optimised payload too, for a richer narrative
          scan.llmReport = await insitesFetchLLMReport(reportId);
          // Cache this fresh audit for future repeat visits (fire-and-forget).
          writeScanCache(parsed.hostname, scan);
          return finish(scan);
        }
        await sleep(INSITES_POLL_INTERVAL_MS);
      }
      logEvent(
        "warn",
        "insites_timeout",
        `Insites audit ${reportId} timed out after ${INSITES_MAX_WAIT_MS}ms — falling back to built-in scanner.`,
        { scanId, reportId }
      );
    } catch (e) {
      logEvent("warn", "insites_error", `Insites audit failed (${e.message}) — falling back to built-in scanner.`, {
        scanId,
        error: e.message,
      });
    }
  }

  // Fallback: built-in scanner
  try {
    const scan = await fallbackScan(url);
    finish(scan);
  } catch (e) {
    fail(e.userFacing ? e.message : "Scan failed. Please try again.");
  }
}

// ---- Competitor comparison (Insites only) -----------------------------------

async function executeCompetitorScan(competitorScanId, competitorUrl, primaryReportId) {
  const entry = competitorScans.get(competitorScanId);
  if (!entry) return;

  try {
    const parsed = normalizeUrl(competitorUrl);
    logEvent("info", "competitor_start", `Competitor audit started for ${parsed.hostname}`, {
      competitorScanId,
      domain: parsed.hostname,
      primaryReportId,
    });

    // Budget check: a domain's own Insites score is a property of that
    // site, not of who it's compared against — so a cached scan of this
    // hostname gives a valid competitor score without spending a credit.
    const cached = await readScanCache(parsed.hostname);
    if (cached && typeof cached.score === "number") {
      delete cached._cacheAgeMs;
      entry.status = "complete";
      entry.domain = cached.domain || parsed.hostname;
      entry.score = cached.score;
      entry.tier = cached.tier || tierForScore(cached.score);
      logEvent("info", "competitor_cache_hit", `Reused cached scan for competitor ${parsed.hostname} — no Insites credit spent.`, {
        competitorScanId,
        domain: parsed.hostname,
      });
      return;
    }

    const { reportId } = await insitesStartAudit(parsed.hostname, {
      is_competitor_of: primaryReportId,
    });

    const deadline = Date.now() + INSITES_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const report = await insitesFetchReport(reportId);
      if (report) {
        const score = Math.max(0, Math.min(100, Math.round(Number(report.overall_score || 0))));
        entry.status = "complete";
        entry.domain = report.domain || parsed.hostname;
        entry.score = score;
        entry.tier = tierForScore(score);
        // Cache the full mapped scan so a later primary scan of this same
        // domain (or another comparison against it) can reuse it.
        writeScanCache(parsed.hostname, mapInsitesReport(report, parsed.toString()));
        logEvent("info", "competitor_complete", `Competitor audit complete: ${entry.domain} scored ${score}`, {
          competitorScanId,
          domain: entry.domain,
          score,
        });
        return;
      }
      await sleep(INSITES_POLL_INTERVAL_MS);
    }
    entry.status = "error";
    entry.error = "Competitor audit timed out.";
    logEvent("warn", "competitor_timeout", `Competitor audit timed out for ${parsed.hostname}`, {
      competitorScanId,
      domain: parsed.hostname,
    });
  } catch (e) {
    entry.status = "error";
    entry.error = e.message || "Competitor audit failed.";
    logEvent("error", "competitor_error", `Competitor audit failed: ${e.message}`, {
      competitorScanId,
      error: e.message,
    });
  }
}



function recommendPackage(signals, locationsCount) {
  const multiLocation = locationsCount && locationsCount >= 2;
  const pages = Number(signals.pagesDiscovered || signals.sitemapUrlCount || 0);
  const largeFootprint = pages >= 75;

  if (multiLocation || largeFootprint) {
    return {
      name: "Smart 1 Dominance Package",
      reason: multiLocation
        ? "Multi-location businesses need coordinated local authority across every profile, which the Dominance package is built for."
        : `With ${pages} pages discovered, this site needs schema and content work across 15+ pages — the Dominance package's scope.`,
      setupInvestment: "$4,500 – $8,000",
      monthlyInvestment: "$499 – $1,000+ / month",
      monthlyEffort: "10–15+ hrs/month of ongoing management",
      projectedScoreRange: "75–95",
    };
  }
  return {
    name: "Smart 1 Authority Package",
    reason:
      "A single-location business with a moderate site footprint is the ideal fit for the Authority package's infrastructure build.",
    setupInvestment: "$5,000 – $7,000",
    monthlyInvestment: "$349 – $499 / month",
    monthlyEffort: "Lighter monthly cadence — analytics, dashboard, and content reviews rather than aggressive multi-location scaling",
    projectedScoreRange: "65–85",
  };
}

// ---- "Would AI cite you?" checklist -----------------------------------------
// Deterministic, not model-generated — this is a truthful readout of the
// actual signals AI answer engines lean on, not a fabricated "we asked
// ChatGPT and here's who it named" claim (which would risk inventing real
// competitor names/rankings we can't verify).

function buildCitationChecklist(scan) {
  const s = scan.signals;
  let items;

  if (scan.engine === "insites") {
    items = [
      {
        label: "Clear business identity (name/address/phone) findable online",
        pass: !!(s.detectedName && s.detectedAddress && s.detectedPhone),
      },
      { label: "Mobile-optimized experience", pass: s.mobileOptimized === true },
      {
        label: "Fast-loading homepage (under 3s)",
        pass: s.homepageLoadSeconds != null && s.homepageLoadSeconds <= 3,
      },
      { label: "Healthy review volume (5+)", pass: (s.reviewsFound || 0) >= 5 },
      {
        label: "Recently updated content (within 6 months)",
        pass: s.daysSinceContentUpdate != null && s.daysSinceContentUpdate <= 180,
      },
      { label: "Analytics tracking in place", pass: !!s.analyticsTool },
    ];
  } else {
    items = [
      {
        label: "Conversational FAQ/HowTo schema for AI to extract",
        pass: !!(s.hasFAQSchema || s.hasHowToSchema),
      },
      { label: "Local business schema markup", pass: !!s.hasLocalBusinessSchema },
      { label: "Clear contact info on homepage", pass: !!s.hasNAP },
      { label: "Substantial page content (600+ words)", pass: (s.wordCount || 0) >= 600 },
      { label: "AI readiness file (llms.txt)", pass: !!s.llmsTxtFound },
      {
        label: "Crawlable & indexable (sitemap + robots.txt)",
        pass: !!s.sitemapFound && !s.robotsBlocksAll,
      },
    ];
  }

  const passCount = items.filter((i) => i.pass).length;
  const total = items.length;
  const headline =
    passCount <= total / 2
      ? `AI engines look for ${total} core signals before citing a local business — ${scan.domain} currently has ${passCount}.`
      : `${scan.domain} already has ${passCount} of ${total} signals AI engines look for — the remaining ${total - passCount} are quick wins.`;

  return { items, passCount, total, headline };
}



async function generateNarrative(scan, lead, pkg) {
  const fallback = {
    headline: `${scan.domain} scores ${scan.score}/100 — ${scan.tier} AI visibility.`,
    summary:
      scan.findings.length > 0
        ? `The site has real gaps holding back AI citation: ${scan.findings.slice(0, 3).join(" ")}`
        : "The site has a solid technical base with room to grow AI citation authority.",
    gaps: scan.findings.slice(0, 4),
  };

  if (!openai) return fallback;

  try {
    // Prefer the Insites LLM-optimised payload when available; otherwise
    // send our normalized signal set.
    const auditContext = scan.llmReport
      ? JSON.stringify(scan.llmReport).slice(0, 12000)
      : JSON.stringify({ signals: scan.signals, findings: scan.findings });

    const prompt = `You are writing a short, plain-English AI-search-readiness summary for a business owner, as part of a Smart 1 Marketing lead-gen tool.

Rules:
- No hype, no invented statistics or numbers you weren't given.
- Frame every gap as a CONSEQUENCE, not a technical description. Don't say "missing FAQ schema" — say what that costs them, e.g. "When someone asks an AI assistant a question you could answer, it answers with a competitor instead, because your site doesn't hand AI engines a clean answer to extract."
- Be specific to the audit data given, not generic.

Site: ${scan.domain}
AI Visibility Score: ${scan.score}/100 (${scan.tier})
Audit data: ${auditContext}
Lead's stated locations: ${lead.locations || "not provided"}
Recommended package: ${pkg.name}

Return JSON only, matching this shape exactly:
{"headline": "one sentence, <20 words", "summary": "2-3 sentences, plain English, consequence-framed", "gaps": ["short consequence-framed gap 1", "short consequence-framed gap 2", "short consequence-framed gap 3", "short consequence-framed gap 4"]}`;

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.4,
      max_tokens: 500,
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    if (!parsed.headline || !parsed.summary) return fallback;
    return parsed;
  } catch (e) {
    console.error("OpenAI narrative generation failed:", e.message);
    logEvent("error", "openai_error", `Narrative generation failed: ${e.message}`, { error: e.message });
    return fallback;
  }
}

// ---- Smart 1 Suite webhook ---------------------------------------------------

async function sendToSmart1Suite(payload) {
  if (!SMART1_WEBHOOK_URL) {
    logEvent("warn", "webhook_skipped", "SMART1_WEBHOOK_URL not set — lead was NOT forwarded to Smart 1 Suite.", {
      domain: payload.scan && payload.scan.domain,
    });
    return { sent: false, reason: "no_webhook_configured" };
  }
  try {
    const res = await fetchWithTimeout(SMART1_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SMART1_WEBHOOK_TOKEN ? { Authorization: `Bearer ${SMART1_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    logEvent(res.ok ? "info" : "warn", "webhook_sent", `Smart 1 Suite webhook returned HTTP ${res.status}`, {
      domain: payload.scan && payload.scan.domain,
      status: res.status,
      ok: res.ok,
    });
    return { sent: res.ok, status: res.status };
  } catch (e) {
    logEvent("error", "webhook_error", `Smart 1 Suite webhook failed: ${e.message}`, {
      domain: payload.scan && payload.scan.domain,
      error: e.message,
    });
    return { sent: false, reason: e.message };
  }
}

async function generateReportPdf(scan, lead, narrative, pkg, checklist) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: 54 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const navy = "#14213f";
      const teal = "#1a9b90";
      const slate = "#5b6b8c";
      const amber = "#e2743f";

      // Header
      doc.fillColor(teal).fontSize(10).font("Helvetica-Bold")
        .text("SMART 1 · AI VISIBILITY REPORT", { characterSpacing: 1 });
      doc.moveDown(0.3);
      doc.fillColor(navy).fontSize(20).font("Helvetica-Bold")
        .text(`${scan.domain} — ${scan.score}/100 (${scan.tier})`);
      doc.moveDown(0.2);
      doc.fillColor(slate).fontSize(9).font("Helvetica")
        .text(`Generated ${new Date().toLocaleDateString()} for ${lead.name}${lead.company ? " · " + lead.company : ""}`);
      doc.moveDown(1);

      // Summary
      doc.fillColor(navy).fontSize(11).font("Helvetica").text(narrative.headline, { lineGap: 4 });
      doc.moveDown(0.3);
      doc.fillColor(slate).fontSize(10).font("Helvetica").text(narrative.summary, { lineGap: 4 });
      doc.moveDown(1);

      // Gaps
      doc.fillColor(navy).fontSize(13).font("Helvetica-Bold").text("Key gaps we found");
      doc.moveDown(0.4);
      (narrative.gaps || []).forEach((g) => {
        doc.fillColor(amber).fontSize(10).font("Helvetica-Bold").text("- ", { continued: true });
        doc.fillColor(navy).font("Helvetica").text(g, { lineGap: 3 });
        doc.moveDown(0.2);
      });
      doc.moveDown(0.6);

      // Citation checklist
      doc.fillColor(navy).fontSize(13).font("Helvetica-Bold").text("Would AI cite you?");
      doc.moveDown(0.2);
      doc.fillColor(slate).fontSize(9).font("Helvetica").text(checklist.headline, { lineGap: 3 });
      doc.moveDown(0.4);
      checklist.items.forEach((item) => {
        doc.fillColor(item.pass ? teal : slate).fontSize(10).font("Helvetica-Bold")
          .text(item.pass ? "[x] " : "[ ] ", { continued: true });
        doc.fillColor(navy).font("Helvetica").text(item.label);
        doc.moveDown(0.15);
      });
      doc.moveDown(0.6);

      // Package recommendation
      doc.rect(doc.x, doc.y, 468, 130).fill(navy);
      const boxTop = doc.y;
      doc.fillColor("#ffffff").fontSize(14).font("Helvetica-Bold")
        .text(pkg.name, 54 + 16, boxTop + 14, { width: 440 });
      doc.fillColor("#c9d3e8").fontSize(9).font("Helvetica")
        .text(pkg.reason, 54 + 16, boxTop + 38, { width: 440, lineGap: 3 });
      doc.fillColor(teal).fontSize(9).font("Helvetica-Bold")
        .text("ONE-TIME SETUP", 54 + 16, boxTop + 82);
      doc.fillColor("#ffffff").fontSize(12).font("Helvetica-Bold")
        .text(pkg.setupInvestment, 54 + 16, boxTop + 95);
      doc.fillColor(teal).fontSize(9).font("Helvetica-Bold")
        .text("MONTHLY OPTIMIZATION", 54 + 220, boxTop + 82);
      doc.fillColor("#ffffff").fontSize(12).font("Helvetica-Bold")
        .text(pkg.monthlyInvestment, 54 + 220, boxTop + 95);

      doc.y = boxTop + 145;
      doc.fillColor(slate).fontSize(9).font("Helvetica")
        .text(`Typical score after setup: ${pkg.projectedScoreRange}/100`, 54, doc.y);
      doc.moveDown(1.2);

      // Footer / CTA
      doc.fillColor(navy).fontSize(10).font("Helvetica-Bold")
        .text(`${CTA_LABEL}: ${CALENDAR_URL}`, { lineGap: 3 });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/** Upload a buffer to Cloudinary as a raw resource. Returns { secure_url, public_id }. */
function uploadBufferToCloudinary(buffer, { publicId, folder, tags }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw",
        // Raw resource public IDs must include the file extension directly —
        // Cloudinary doesn't reliably apply a separate `format` param to
        // raw uploads the way it does for image/video.
        public_id: publicId,
        folder,
        tags,
        overwrite: true,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
}

/**
 * Generates the PDF report and uploads both the PDF and the full raw
 * Insites audit payload to Cloudinary. Non-fatal on failure — the report
 * still renders in the widget even if Cloudinary is unreachable; the
 * webhook payload just carries null URLs in that case.
 */
async function persistReportToCloudinary(scanId, scan, lead, narrative, pkg, checklist) {
  const result = { reportPdfUrl: null, rawDataUrl: null };
  if (!cloudinaryConfigured) return result;

  const safeDomain = scan.domain.replace(/[^a-z0-9.-]/gi, "_");
  const basePublicId = `${safeDomain}-${scanId}`;

  try {
    const pdfBuffer = await generateReportPdf(scan, lead, narrative, pkg, checklist);
    const pdfUpload = await uploadBufferToCloudinary(pdfBuffer, {
      publicId: `${basePublicId}.pdf`,
      folder: `${CLOUDINARY_FOLDER}/pdf`,
      tags: ["ai-visibility-report", "pdf"],
    });
    result.reportPdfUrl = pdfUpload.secure_url;
    logEvent("info", "cloudinary_pdf_uploaded", `PDF uploaded for ${scan.domain}`, {
      domain: scan.domain,
      url: pdfUpload.secure_url,
    });
  } catch (e) {
    console.error("Cloudinary PDF upload failed:", e.message);
    logEvent("error", "cloudinary_pdf_error", `PDF upload failed for ${scan.domain}: ${e.message}`, {
      domain: scan.domain,
      error: e.message,
    });
  }

  try {
    const rawPayload = JSON.stringify(
      {
        domain: scan.domain,
        engine: scan.engine,
        score: scan.score,
        tier: scan.tier,
        signals: scan.signals,
        findings: scan.findings,
        insitesReportId: scan.insitesReportId,
        insitesRawAudit: scan.raw, // full Insites payload, null on fallback engine
        lead: { name: lead.name, email: lead.email, company: lead.company || null },
        capturedAt: new Date().toISOString(),
      },
      null,
      2
    );
    const rawUpload = await uploadBufferToCloudinary(Buffer.from(rawPayload, "utf8"), {
      publicId: `${basePublicId}-raw.json`,
      folder: `${CLOUDINARY_FOLDER}/raw-data`,
      tags: ["ai-visibility-report", "raw-data", scan.engine],
    });
    result.rawDataUrl = rawUpload.secure_url;
    logEvent("info", "cloudinary_raw_uploaded", `Raw audit data uploaded for ${scan.domain}`, {
      domain: scan.domain,
      url: rawUpload.secure_url,
    });
  } catch (e) {
    console.error("Cloudinary raw-data upload failed:", e.message);
    logEvent("error", "cloudinary_raw_error", `Raw-data upload failed for ${scan.domain}: ${e.message}`, {
      domain: scan.domain,
      error: e.message,
    });
  }

  return result;
}



app.use(express.static("public"));

/** Start a scan; returns immediately with a scanId the frontend polls. */
app.post("/api/scan", (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "A website URL is required." });
  }

  let parsed;
  try {
    parsed = normalizeUrl(url);
  } catch (e) {
    return res.status(422).json({ error: e.userFacing ? e.message : "That doesn't look like a valid website address." });
  }
  const cleanUrl = parsed.toString();

  const scanId = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  scans.set(scanId, {
    status: "running",
    createdAt: Date.now(),
    url: cleanUrl,
    scan: null,
    error: null,
  });

  executeScan(scanId, cleanUrl); // fire-and-forget; frontend polls

  res.status(202).json({ scanId, engine: INSITES_API_KEY ? "insites" : "builtin" });
});

/** Poll for scan status; returns teaser data (never the full findings). */
app.get("/api/scan/:id/status", (req, res) => {
  const entry = scans.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "Scan not found or expired." });

  if (entry.status === "running") {
    return res.json({ status: "running" });
  }
  if (entry.status === "error") {
    return res.json({ status: "error", error: entry.error });
  }
  const { scan } = entry;
  res.json({
    status: "complete",
    domain: scan.domain,
    score: scan.score,
    tier: scan.tier,
    engine: scan.engine,
    teaserFinding: scan.findings[0] || "Your site has structural gaps limiting AI citation.",
    gapCount: scan.findings.length,
  });
});

/** Lead capture unlocks the full report AND fires the CRM webhook. */
app.post("/api/unlock", async (req, res) => {
  const { scanId, lead } = req.body || {};
  const entry = scanId && scans.get(scanId);
  if (!entry || entry.status !== "complete") {
    return res.status(404).json({ error: "That scan has expired. Please run the scan again." });
  }
  if (!lead || !lead.name || !lead.email) {
    return res.status(400).json({ error: "Name and email are required." });
  }

  const { scan } = entry;
  const locationsCount = Number(lead.locations) || 1;
  const pkg = recommendPackage(scan.signals, locationsCount);
  const narrative = await generateNarrative(scan, lead, pkg);
  const checklist = buildCitationChecklist(scan);

  // Generate the PDF and persist it (plus the full raw Insites audit) to
  // Cloudinary. Both URLs ride along in the webhook so they're durably
  // retrievable later — not just for the lifetime of the in-memory scan
  // cache. Non-fatal: report still renders even if this fails.
  const { reportPdfUrl, rawDataUrl } = await persistReportToCloudinary(
    scanId,
    scan,
    lead,
    narrative,
    pkg,
    checklist
  );

  const webhookPayload = {
    source: "ai-visibility-scan-funnel",
    submittedAt: new Date().toISOString(),
    lead: {
      name: lead.name,
      email: lead.email,
      phone: lead.phone || null,
      company: lead.company || null,
      website: scan.url,
      locations: locationsCount,
    },
    scan: {
      engine: scan.engine,
      domain: scan.domain,
      score: scan.score,
      tier: scan.tier,
      signals: scan.signals,
      findings: scan.findings,
      insitesReportId: scan.insitesReportId,
      citationChecklist: checklist,
    },
    // Full Insites audit payload rides along directly too (in addition to
    // the durable Cloudinary copy at rawDataUrl below).
    insitesReport: scan.raw,
    recommendation: pkg,
    // Cloudinary-hosted assets. Smart 1 Suite's own email automation is
    // responsible for actually sending the report — this app does not
    // send email directly. sendReportEmail flags that the lead opted in.
    reportPdfUrl,
    rawDataUrl,
    sendReportEmail: !!lead.wantsEmail,
  };

  const webhookResult = await sendToSmart1Suite(webhookPayload);

  // Mark the scan as "unlocked" rather than deleting it — the competitor
  // comparison endpoint needs the primary Insites report ID a little longer.
  // TTL cleanup still reclaims it after SCAN_TTL_MS.
  entry.leadCaptured = true;
  logEvent("info", "lead_captured", `Lead captured for ${scan.domain} (${maskEmail(lead.email)})`, {
    domain: scan.domain,
    email: maskEmail(lead.email),
    package: pkg.name,
    reportPdfUrl,
  });

  res.json({
    scanId,
    domain: scan.domain,
    score: scan.score,
    tier: scan.tier,
    engine: scan.engine,
    findings: scan.findings,
    signals: scan.signals,
    headline: narrative.headline,
    summary: narrative.summary,
    gaps: narrative.gaps,
    package: pkg,
    citationChecklist: checklist,
    bookingUrl: CALENDAR_URL,
    ctaLabel: CTA_LABEL,
    crmForwarded: webhookResult.sent,
    reportPdfUrl,
    emailRequested: !!lead.wantsEmail,
    competitorAvailable: scan.engine === "insites",
  });
});

/** Optional: kick off a competitor audit (Insites only) after unlock. */
app.post("/api/competitor", (req, res) => {
  const { scanId, competitorUrl } = req.body || {};
  const entry = scanId && scans.get(scanId);
  if (!entry || !entry.leadCaptured) {
    return res.status(403).json({ error: "Unlock the report before requesting a competitor comparison." });
  }
  if (entry.scan.engine !== "insites") {
    return res.status(400).json({ error: "Competitor comparison requires the Insites engine." });
  }
  if (!competitorUrl || typeof competitorUrl !== "string") {
    return res.status(400).json({ error: "A competitor website is required." });
  }
  if (!entry.scan.insitesReportId) {
    return res.status(400).json({ error: "Primary report isn't ready for comparison yet." });
  }

  const competitorScanId = `cscan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  competitorScans.set(competitorScanId, {
    status: "running",
    createdAt: Date.now(),
    domain: null,
    score: null,
    tier: null,
    error: null,
  });

  executeCompetitorScan(competitorScanId, competitorUrl, entry.scan.insitesReportId);

  res.status(202).json({ competitorScanId });
});

app.get("/api/competitor/:id/status", (req, res) => {
  const entry = competitorScans.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "Comparison not found or expired." });
  res.json({
    status: entry.status,
    domain: entry.domain,
    score: entry.score,
    tier: entry.tier,
    error: entry.error,
  });
});

/** Public, non-secret display config the frontend fetches on load. */
app.get("/api/config", (_req, res) => {
  res.json({
    ctaLabel: CTA_LABEL,
    trustLine: TRUST_LINE,
    sampleReportUrl: SAMPLE_REPORT_URL || null,
    reportDeliveryAvailable: cloudinaryConfigured && !!SMART1_WEBHOOK_URL,
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: !!openai,
    webhookConfigured: !!SMART1_WEBHOOK_URL,
    insitesConfigured: !!INSITES_API_KEY,
    cloudinaryConfigured,
    debugConfigured: !!DEBUG_TOKEN,
  });
});

// ---- Troubleshooting panel API (see /debug.html) ---------------------------
// Disabled entirely (404) unless DEBUG_TOKEN is set, so an unconfigured
// deploy exposes nothing. When set, every request must present it via
// ?token= or an X-Debug-Token header.
function checkDebugToken(req, res) {
  if (!DEBUG_TOKEN) {
    res.status(404).json({ error: "Not found." });
    return false;
  }
  const provided = req.query.token || req.get("X-Debug-Token");
  if (provided !== DEBUG_TOKEN) {
    res.status(403).json({ error: "Invalid or missing debug token." });
    return false;
  }
  return true;
}

app.get("/api/debug/log", (req, res) => {
  if (!checkDebugToken(req, res)) return;
  const level = req.query.level; // "error" | "warn" | "info" | undefined (all)
  const limit = Math.min(Number(req.query.limit) || 100, MAX_LOG_ENTRIES);
  let entries = activityLog;
  if (level && level !== "all") entries = entries.filter((e) => e.level === level);
  // most recent first
  entries = entries.slice(-limit).reverse();
  res.json({
    entries,
    totalBuffered: activityLog.length,
    bufferCapacity: MAX_LOG_ENTRIES,
  });
});

app.get("/api/debug/state", (req, res) => {
  if (!checkDebugToken(req, res)) return;
  const now = Date.now();
  const scanSnapshot = [...scans.entries()].map(([id, s]) => ({
    scanId: id,
    status: s.status,
    url: s.url,
    domain: s.scan ? s.scan.domain : null,
    engine: s.scan ? s.scan.engine : null,
    score: s.scan ? s.scan.score : null,
    error: s.error || null,
    leadCaptured: !!s.leadCaptured,
    ageMs: now - s.createdAt,
  }));
  const competitorSnapshot = [...competitorScans.entries()].map(([id, s]) => ({
    competitorScanId: id,
    status: s.status,
    domain: s.domain,
    score: s.score,
    error: s.error || null,
    ageMs: now - s.createdAt,
  }));
  res.json({
    now: new Date().toISOString(),
    config: {
      openaiConfigured: !!openai,
      webhookConfigured: !!SMART1_WEBHOOK_URL,
      insitesConfigured: !!INSITES_API_KEY,
      cloudinaryConfigured,
      insitesMaxWaitMs: INSITES_MAX_WAIT_MS,
      insitesCacheTtlDays: INSITES_CACHE_TTL_DAYS,
      scanTtlMs: SCAN_TTL_MS,
    },
    scans: scanSnapshot,
    competitorScans: competitorSnapshot,
  });
});

function startServer() {
  app.listen(PORT, () => {
    console.log(`Smart 1 AI Visibility Scan (v2) running on port ${PORT}`);
    console.log(`Analysis engine: ${INSITES_API_KEY ? "Insites Audit API (with built-in fallback)" : "built-in scanner only"}`);
    if (!OPENAI_API_KEY) console.warn("⚠️  OPENAI_API_KEY not set — narrative will use fallback text.");
    if (!SMART1_WEBHOOK_URL) console.warn("⚠️  SMART1_WEBHOOK_URL not set — leads will NOT reach Smart 1 Suite.");
    if (!INSITES_API_KEY) console.warn("⚠️  INSITES_API_KEY not set — using built-in scanner instead of Insites audits.");
    if (!cloudinaryConfigured) console.warn("⚠️  Cloudinary env vars not set — reports will NOT be generated or stored as PDFs.");
    if (DEBUG_TOKEN) console.log("🔧 Troubleshooting panel active at /debug.html");
    else console.warn("⚠️  DEBUG_TOKEN not set — /debug.html troubleshooting panel is disabled.");
    if (INSITES_API_KEY) {
      if (cloudinaryConfigured && INSITES_CACHE_TTL_MS > 0) {
        console.log(`💰 Insites credit-saver: reusing cached scans for up to ${INSITES_CACHE_TTL_DAYS} days.`);
      } else if (INSITES_CACHE_TTL_MS <= 0) {
        console.warn("⚠️  INSITES_CACHE_TTL_DAYS=0 — every scan spends a fresh Insites credit (cache disabled).");
      } else {
        console.warn("⚠️  Cloudinary not configured — scan cache is OFF, so every scan spends a fresh Insites credit.");
      }
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  scans,
  competitorScans,
  startServer,
  generateReportPdf,
  buildCitationChecklist,
  recommendPackage,
};
