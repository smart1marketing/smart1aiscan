# Smart 1 — AI Visibility Scan (lead funnel)

A drop-in lead-gen widget for Smart 1 Marketing. A visitor enters a website
URL → the app runs a **real Insites audit** (SEO, local presence, reviews,
speed, mobile, content) → shows a teaser score → gates the full report +
recommended package behind a short lead form → forwards the lead, the scan
summary, AND the full Insites audit payload to Smart 1 Suite via webhook.

**v2:** the Insites Audit API is the primary analysis engine. The original
built-in Cheerio scanner remains as an automatic fallback — if the Insites
key isn't set, an audit errors, or it times out (default 150s), the funnel
degrades gracefully instead of going down. Scans are now asynchronous: the
frontend polls `/api/scan/:id/status` while the audit runs (~60–90s for
Insites, a few seconds for fallback).

## v2.1 — conversion features

On top of the scan/report/webhook core, the funnel now includes:

- **"Would AI cite you?" checklist** — a deterministic (not model-generated)
  pass/fail readout of the real signals AI answer engines rely on, built
  from the actual audit data. This is the honest version of "we asked
  ChatGPT about you" — it doesn't fabricate a live AI query or invent real
  competitor names/rankings, but it makes the same point with the data we
  actually have.
- **Competitor comparison** (Insites engine only) — an optional field on the
  lead form ("biggest competitor's website") auto-triggers a second Insites
  audit via `is_competitor_of`, shown side-by-side once it completes. There's
  also a manual "Compare" form in the report if they skip it upfront.
- **Score projection bar** — shows today's score against the typical range
  after the recommended package (`package.projectedScoreRange`).
- **Consequence-framed gaps** — the OpenAI narrative prompt now explicitly
  reframes technical findings as business consequences ("AI answers with a
  competitor instead of you") rather than jargon.
- **Rotating educational stat cards** during the scan wait — keeps the ~60–90s
  Insites audit from feeling like dead time.
- **PDF report + durable audit archive** — see v2.2 below.
- **Configurable conversion copy** — CTA label, trust line, and an optional
  "see a sample report" link, all set via env vars with no code changes.

## v2.2 — PDF report, Cloudinary storage, Smart 1 Suite owns the email send

On lead capture, the app now:

1. Renders the report as a **PDF** (via `pdfkit` — no headless browser, no
   Puppeteer/Chromium to deploy).
2. Uploads that PDF to **Cloudinary** as a `raw` resource.
3. Also uploads the **full raw Insites audit payload** (JSON) to Cloudinary,
   separately from the PDF — this is the durable archive: the in-memory scan
   cache is wiped after ~60 minutes, but the Cloudinary copy persists, so you
   can pull up any lead's complete audit data later even after the scan
   itself has expired.
4. Both URLs (`reportPdfUrl`, `rawDataUrl`) ride along in the Smart 1 Suite
   webhook payload, plus a `sendReportEmail` boolean reflecting whether the
   lead opted in via the "email me a copy" checkbox.

**This app does not send email itself.** It hands Smart 1 Suite everything
it needs (the lead's email, the PDF link, the `sendReportEmail` flag) and
Smart 1 Suite's own automation is responsible for actually sending the
report. If Smart 1 Suite doesn't yet have an automation keyed off this
webhook, that's the piece to build on that side — this app's job stops at
"here's the lead, here's their PDF, here's whether they asked for a copy."

If `CLOUDINARY_*` env vars aren't set, the report still renders normally in
the widget — `reportPdfUrl`/`rawDataUrl` just come back `null`, and a
console warning fires on startup so it's obvious in the Render logs.

**Flow:** enter URL → scan animation → teaser score (blurred/gated) → lead
capture → full report + package recommendation + "Book a Call" CTA. This is
the same shape as a qualify-then-reveal lead funnel (ask a couple of
qualifying questions, then unlock the quote) — here the qualifying question
is "how many locations do you operate?", which feeds the Authority vs.
Dominance package recommendation.

## What it checks

**Primary engine — Insites Audit API** (`INSITES_API_KEY` set): a real
multi-page audit covering pages discovered, titles/descriptions, mobile
optimization, homepage speed, reviews found, detected business identity
(name/address/phone across the web), content volume and freshness, analytics
detection, backlinks, and domain age — plus Insites' own `overall_score`
(0–100), which becomes the AI Visibility Score directly. The exact checks
depend on your Insites account configuration. The LLM-optimised payload
(`/llm/report-fetch`) is also pulled and fed to OpenAI for a richer
narrative.

**Fallback engine — built-in scanner** (no key, or Insites fails/times
out): homepage HTML (title, meta, JSON-LD schema types, NAP pattern, word
count), robots.txt, sitemap.xml, llms.txt — scored 0–100 by deterministic
rules.

Both map into the same Critical / Competitive / Strong / Dominant tiers
matching the gauge in the AI Search Architecture Blueprint. The webhook
payload includes an `engine` field ("insites" or "builtin") so you can see
in the CRM which one produced each lead's score.

## 1. Local setup

```bash
npm install
cp .env.example .env
# fill in OPENAI_API_KEY and SMART1_WEBHOOK_URL in .env
npm start
```

Visit `http://localhost:3000`.

## 2. Deploy to Render (via GitHub)

1. Push this folder to a new GitHub repo.
2. In Render: **New → Blueprint**, point it at the repo. `render.yaml` is
   already set up (Node web service, `npm install` / `npm start`).
   - Alternatively: **New → Web Service**, connect the repo, and Render will
     detect Node automatically (build: `npm install`, start: `npm start`).
3. In the Render dashboard, set the environment variables it prompts for
   (`sync: false` ones aren't stored in the repo, so you enter them once in
   Render):
   - `OPENAI_API_KEY`
   - `SMART1_WEBHOOK_URL` — **you'll need this from your Smart 1 Suite
     account's lead-intake/webhook settings.** Until it's set, scans still
     run and reports still generate, but leads won't reach the CRM (check
     the Render logs — it warns loudly).
   - `SMART1_WEBHOOK_TOKEN` — only if Smart 1 Suite requires a bearer token
     on that webhook.
   - `INSITES_API_KEY` — from your Insites account settings (Account →
     API keys). This is what switches on real Insites audits. Note that
     each scan consumes an Insites audit credit; the app reuses any audit
     of the same hostname run within the last 24h (`check_for_existing`)
     to limit spend from repeat visitors.
4. Deploy. Render gives you a URL like
   `https://smart1-ai-visibility-funnel.onrender.com`.

## 3. Embed it on a page

**Option A — iframe (simplest, fully isolated):**

```html
<iframe
  src="https://smart1-ai-visibility-funnel.onrender.com"
  style="width:100%; max-width:600px; height:720px; border:0;"
  title="Smart 1 AI Visibility Scan">
</iframe>
```

Resize the iframe's `height` per step if you embed it on a page where you
control the surrounding layout — the widget's content height changes as the
visitor moves through the flow.

**Option B — direct embed on a page you control**, by copying
`public/index.html`'s `<div id="widget">…</div>` block plus `styles.css` and
`app.js` into your page. If the widget's origin differs from the page it's
embedded on, add before `app.js`:

```html
<script>window.SMART1_API_BASE = "https://smart1-ai-visibility-funnel.onrender.com";</script>
<script src="https://smart1-ai-visibility-funnel.onrender.com/app.js"></script>
```

## 4. What gets sent to Smart 1 Suite

On lead capture (`POST /api/unlock`), this JSON is POSTed to
`SMART1_WEBHOOK_URL`:

```json
{
  "source": "ai-visibility-scan-funnel",
  "submittedAt": "2026-07-17T18:00:00.000Z",
  "lead": {
    "name": "...", "email": "...", "phone": "...", "company": "...",
    "website": "https://example.com", "locations": 1
  },
  "scan": {
    "engine": "insites",
    "domain": "example.com", "score": 62, "tier": "Strong",
    "signals": { "...": "normalized scan signals" },
    "findings": ["..."],
    "insitesReportId": "7b8cf004..."
  },
  "insitesReport": { "...": "the FULL raw Insites audit payload (null when fallback ran)" },
  "recommendation": {
    "name": "Smart 1 Authority Package",
    "reason": "...",
    "setupInvestment": "$5,000 – $7,000",
    "monthlyInvestment": "$349 – $499 / month",
    "projectedScoreRange": "65–85"
  },
  "reportPdfUrl": "https://res.cloudinary.com/.../smart1-ai-visibility-reports/pdf/example.com-scan_xxx.pdf",
  "rawDataUrl": "https://res.cloudinary.com/.../smart1-ai-visibility-reports/raw-data/example.com-scan_xxx-raw.json",
  "sendReportEmail": true
}
```

`reportPdfUrl` / `rawDataUrl` come back `null` if Cloudinary isn't
configured or an upload fails — the webhook still fires with everything
else intact either way. `sendReportEmail` reflects the lead's "email me a
copy" checkbox; **Smart 1 Suite's own automation is what should act on
that flag and actually send the email** — this app only generates and
stores the PDF, it doesn't send mail itself.

If your Smart 1 Suite webhook expects a different field layout, adjust the
`webhookPayload` object in `server.js` (`sendToSmart1Suite` call site) — it's
one object literal, easy to reshape.

## 4b. New endpoints (v2.1)

- `POST /api/competitor` — `{ scanId, competitorUrl }`. Only usable after
  `/api/unlock` on that scanId (guards against running comparisons before a
  lead is captured). Requires the Insites engine. Returns
  `{ competitorScanId }`.
- `GET /api/competitor/:id/status` — poll target for the above. Returns
  `{ status: "running" | "complete" | "error", domain, score, tier }`.
- `GET /api/config` — public, non-secret display config
  (`ctaLabel`, `trustLine`, `sampleReportUrl`, `reportDeliveryAvailable`). The
  frontend fetches this once on load.
- `GET /api/debug/log?token=...&level=&limit=` — troubleshooting log (see
  v2.3 below). 404 unless `DEBUG_TOKEN` is set; 403 on a wrong token.
- `GET /api/debug/state?token=...` — live snapshot of in-flight
  scans/competitor comparisons and integration config. Same gating.

## 5. Package logic (edit in `server.js` → `recommendPackage`)

- **Dominance package** if the lead reports 2+ locations, or the audit
  discovered 75+ pages (Insites `pages_discovered_count`, or sitemap URL
  count in fallback mode).
- **Authority package** otherwise.

Figures are hard-coded from Smart 1's current pricing:

| | Authority | Dominance |
|---|---|---|
| One-time setup | $5,000 – $7,000 | $4,500 – $8,000 |
| Monthly optimization | $349 – $499/mo | $499 – $1,000+/mo |

## v2.3 — troubleshooting panel

`/debug.html` is a separate, internal-only page (not linked from the funnel
itself) for diagnosing exactly the kind of issue that motivated it: a scan
that seems to hang, a webhook that isn't firing, a Cloudinary upload that's
silently failing. It's disabled by default — nothing at `/api/debug/*`
responds until you set `DEBUG_TOKEN`, and even then every request must
present it.

What it shows:

- **System status** — which integrations (OpenAI, Insites, Cloudinary,
  Smart 1 Suite webhook) are actually configured on this deployment.
- **Run a test scan** — fires the same public `/api/scan` endpoint the
  widget uses and streams every raw request/response as it happens, so you
  can reproduce an issue live instead of waiting for a real visitor to hit it.
- **In-flight scans / competitor comparisons** — a live table of whatever's
  currently in the server's memory: status, engine, domain, age, and
  whether a lead was captured. If something's stuck, this is where you'd
  see it sitting in "running" long past when it should have finished.
- **Activity log** — a rolling, filterable log (info/warn/error) of every
  scan start/complete/error, Insites timeout, Cloudinary upload result, and
  webhook attempt. This is an in-memory ring buffer (last 300 events,
  resets on deploy/restart) — it's a live troubleshooting aid, not a
  durable audit trail. Lead emails are masked (`j***@example.com`) before
  they ever enter the buffer, so a leaked debug token doesn't expose full
  contact info.

Setup: set `DEBUG_TOKEN` to any long random string in Render's env vars,
redeploy, then visit `https://your-service.onrender.com/debug.html` and
paste the token in. Treat the token like a password — anyone with it can
see recent scan activity (masked-email lead captures, error messages,
which sites were scanned).

## v2.4 — honest timing, stay-on-page warning, animated tip carousel

**Timing philosophy changed.** Earlier versions capped the Insites wait at
90s to keep things fast, but real audits were regularly needing more than
that (see the "spins and spins" incident) — so scans were quietly falling
back to the lower-quality built-in scanner more often than intended.
`INSITES_MAX_WAIT_MS` is now 200s by default (worst case ~3.5-4 minutes
including fallback), and every piece of copy in the widget says "3-4
minutes" up front instead of implying it'll be fast. Better to set honest
expectations than to either rush the analysis or leave people guessing.

**The scan runs server-side, not in the browser** — closing the tab
doesn't stop the audit on Render, but the widget has no way to reconnect
to a scan after a page reload (the scanId only lives in that page's JS
memory), so closing the tab still means losing the result. Two things now
make that explicit:
- A visible "Keep this tab open" warning appears during the scan.
- A real `beforeunload` browser confirmation fires if someone tries to
  navigate away mid-scan (browsers show their own generic wording here,
  not custom text — that's a browser security restriction, not a bug).

**Animated SVG tip carousel** replaces the old plain-text stat rotator.
Six small looping SVG animations (CSS keyframes, no JS animation loop —
cheap to render), each paired with a one-line AI-visibility tip, holding
for ~17s before crossfading to the next. Over a 3-4 minute wait that's
roughly 2-3 full loops through all six. Edit `TIP_CARDS` in `public/app.js`
to add, remove, or reorder tips — each entry is just `{ caption, svg }`.

## v2.5 — robust URL entry: instructions + auto-correction

People will enter the URL field every way imaginable — with `https://`,
with `www.`, with stray spaces around dots, pasted with quotes, with a
trailing period from the end of a sentence, in caps, as a full URL with a
path and tracking params. Rather than rely on people reading instructions
perfectly, both ends now handle it:

- **`normalizeUrl()` in `server.js`** is the authoritative validator —
  strips wrapping quotes, collapses internal whitespace, strips a leading
  `//`, strips a trailing period, adds `https://` only if no protocol is
  present, and requires at least one dot in the hostname before accepting
  it. Genuinely bad input (empty, no dot, wrong protocol) gets a specific,
  actionable error message instead of a generic one — and that message
  now actually reaches the widget (`/api/scan` was previously discarding
  the real error and always showing a generic one).
- **The entry form has an explicit instruction line** ("Just the domain —
  no need to type https:// or www.") plus `inputmode="url"` and disabled
  autocorrect/autocapitalize, since mobile keyboards "helpfully"
  capitalizing or autocorrecting a domain is a real source of bad input.
- **A live preview** under the input mirrors the backend's logic in the
  browser and shows "→ we'll scan: example.com" as they type, so people
  get confirmation of exactly what will be scanned before submitting,
  without a round trip to the server. It stays silent (no scary red text)
  while the input still looks incomplete — it only ever shows positive
  confirmation once it can resolve a real-looking domain.
- The same fix also covers the **competitor-comparison field** — it was
  already routing through `normalizeUrl()`'s error message, so the clearer
  messages apply there too with no extra code.

## v2.6 — Insites credit budgeting (domain scan cache)

Every completed Insites scan is already stored in Cloudinary. This version
actually *uses* that: before spending an Insites credit, the app looks for
a stored scan of the same domain and reuses it if it's recent enough.

- **Two layers of reuse, both active now.** Insites' own
  `check_for_existing` (short-lived, their retention) was already there;
  this adds our own durable, domain-keyed cache in Cloudinary with a
  configurable window. A repeat visit to a domain scanned last week now
  costs zero credits instead of a fresh audit.
- **`INSITES_CACHE_TTL_DAYS`** (default 30) controls the reuse window. Set
  it to 0 to always run fresh audits (cache off). Requires Cloudinary to be
  configured — that's where scans live. Without Cloudinary, every scan
  spends a credit and the startup logs say so plainly.
- **Cache key is the bare domain** (`www.` stripped, lowercased), so
  `example.com` and `www.example.com` share one entry, and it overwrites in
  place — exactly one cache file per domain, always the latest scan.
- **Competitor comparisons use it too.** A domain's own Insites score is a
  property of that site, not of who it's compared against, so a cached scan
  gives a valid competitor score without a credit — and a fresh competitor
  audit populates the cache for later primary scans of that domain.
- **Visible in the troubleshooting panel.** Cache hits log as `cache_hit` /
  `competitor_cache_hit` (vs `insites_start` for a fresh credit spend), and
  the Run-a-Test-Scan panel shows the current credit-saver status.

One caveat: the cache reflects the site as it was when last scanned. If a
prospect makes changes and re-scans within the TTL window, they'll see the
older result until it expires. Drop `INSITES_CACHE_TTL_DAYS` if freshness
matters more than credits for your use case.

## Notes / things to swap before real launch

- **Scan state is in-memory** (`scans` / `competitorScans` Maps in
  `server.js`), which resets on every deploy/restart and won't work across
  multiple Render instances. This is fine for the *live scan/report flow*
  (a lead unlocks their report within the same session it was generated).
  It's **not** what durably stores the report — that's Cloudinary, which
  persists independently of this in-memory cache. Swap the in-memory Maps
  for Redis if you scale past a single instance or add autoscaling.
- **Email delivery is intentionally NOT this app's job.** It generates the
  PDF, uploads it (and the raw audit data) to Cloudinary, and hands both
  URLs to Smart 1 Suite via the webhook along with a `sendReportEmail`
  flag. Smart 1 Suite's own automation needs to actually send the email —
  if that automation doesn't exist yet on the Smart 1 Suite side, that's
  the remaining piece to build there, not here.
- **PDF design is intentionally simple** (`pdfkit`, no headless browser) —
  it's a clean, readable, on-brand document but not a pixel-perfect replica
  of the widget's UI. If you want the PDF to visually match the widget more
  closely (gauge graphic, exact fonts), that would mean switching to an
  HTML-to-PDF renderer (e.g., Puppeteer), which adds real deploy weight
  (headless Chromium) — worth it only if the visual fidelity is a
  requirement, not just a nice-to-have.
- The OpenAI call only writes the narrative copy (headline/summary/gap
  phrasing); the score itself is rule-based and deterministic, so it won't
  drift or hallucinate.
