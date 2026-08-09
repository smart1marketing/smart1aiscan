(function () {
  const APP_VERSION = "2.6.3";
  window.__SMART1_AI_SCAN_VERSION__ = APP_VERSION;
  console.info(`[Smart 1 AI Scan] frontend v${APP_VERSION} loaded`);

  const widget = document.getElementById("widget");
  const steps = widget.querySelectorAll(".step");

  function showStep(name) {
    steps.forEach((s) => {
      s.hidden = s.dataset.step !== name;
    });
  }

  function apiBase() {
    // Same-origin by default. If this widget is embedded via <script> on a
    // different domain than the Render service, set window.SMART1_API_BASE
    // before including app.js:
    // <script>window.SMART1_API_BASE = "https://your-service.onrender.com";</script>
    return window.SMART1_API_BASE || "";
  }

  async function requestJSON(path, opts) {
    // A hung fetch (dropped connection, Render cold-sleeping, etc.) with no
    // timeout would freeze this await forever — and since the poll loop's
    // deadline check only re-runs *after* this resolves, a single stuck
    // request could silently trap the whole scan step indefinitely (the
    // elapsed-time counter, on its own independent setInterval, would keep
    // ticking the whole time, masking the freeze). Bound every request.
    const timeoutMs = (opts && opts.timeoutMs) || 20000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(apiBase() + path, { ...opts, signal: controller.signal, cache: "no-store" });
    } catch (e) {
      if (e.name === "AbortError") {
        throw new Error("Request timed out. Retrying…");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  function postJSON(path, body, timeoutMs) {
    return requestJSON(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs,
    });
  }

  function showError(message) {
    document.getElementById("errorMessage").textContent = message;
    showStep("error");
  }

  // ---- Load display config (CTA copy, trust line, sample report) ----------
  (async function loadConfig() {
    try {
      const cfg = await requestJSON("/api/config");
      if (cfg.ctaLabel) {
        document.getElementById("bookCallLabel").textContent = cfg.ctaLabel;
      }
      if (cfg.trustLine) {
        document.getElementById("trustLine").textContent = cfg.trustLine;
      }
      if (cfg.sampleReportUrl) {
        const link = document.getElementById("sampleReportLink");
        link.href = cfg.sampleReportUrl;
        link.hidden = false;
      }
    } catch (_) {
      /* non-critical — defaults already in the markup */
    }
  })();

  // ---- Step 0: entry ------------------------------------------------------
  const entryForm = document.getElementById("entryForm");
  const urlInput = document.getElementById("urlInput");
  let lastUrl = "";

  // Mirrors the backend's normalizeUrl (server.js) for an instant preview —
  // the backend remains the authoritative validator; this is purely a
  // reassurance/correction hint so people see what will actually be
  // scanned before they submit. Returns a clean hostname, or null if the
  // input doesn't look like a domain yet (stays quiet rather than showing
  // scary errors while someone's still mid-typing).
  function previewHostname(raw) {
    let url = String(raw || "").trim();
    url = url.replace(/^['"]+|['"]+$/g, "");
    url = url.replace(/\s+/g, "");
    url = url.replace(/^\/\/+/, "");
    url = url.replace(/\.+$/, "");
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      if (!parsed.hostname.includes(".")) return null;
      return parsed.hostname;
    } catch (_) {
      return null;
    }
  }

  urlInput.addEventListener("input", () => {
    const preview = document.getElementById("urlPreview");
    if (!preview) return;
    const host = previewHostname(urlInput.value);
    preview.textContent = host ? `→ we'll scan: ${host}` : "";
  });

  entryForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    lastUrl = url;
    runScan(url);
  });

  document.getElementById("retryBtn").addEventListener("click", () => {
    if (lastUrl) runScan(lastUrl);
    else showStep("entry");
  });

  // ---- Step 1: scanning + polling -----------------------------------------
  // A real Insites audit can take up to ~90s before falling back. Rather
  // than one canned message, show a live elapsed timer and update the
  // reassurance copy at honest thresholds so a 60-90s wait doesn't read as
  // "broken" — it reads as "working, and here's proof."

  let checklistTimer = null;

  function startChecklistLoop() {
    const items = Array.from(document.querySelectorAll("#checklist li"));
    items.forEach((li) => li.classList.remove("active", "done"));
    let i = 0;

    stopChecklistLoop();
    checklistTimer = setInterval(() => {
      if (i > 0) {
        items[i - 1].classList.remove("active");
        items[i - 1].classList.add("done");
      }
      if (i < items.length) {
        items[i].classList.add("active");
        i++;
      } else {
        items.forEach((li) => li.classList.remove("active", "done"));
        i = 0;
      }
    }, 1400);
  }

  function stopChecklistLoop() {
    if (checklistTimer) {
      clearInterval(checklistTimer);
      checklistTimer = null;
    }
  }

  // ---- Live elapsed timer + honest, threshold-based reassurance copy ------
  const SCAN_NOTE_THRESHOLDS = [
    { atSeconds: 8, text: "Crawling site pages and checking structure — this runs a real multi-page audit." },
    { atSeconds: 35, text: "Checking local presence, business identity, and reviews." },
    { atSeconds: 70, text: "Testing speed and mobile experience — larger sites take a bit longer here." },
    { atSeconds: 110, text: "Calculating your AI Visibility Score. A full audit usually takes 3–4 minutes." },
    { atSeconds: 160, text: "Still working — thorough audits of bigger sites can run toward the top of that range." },
    { atSeconds: 210, text: "Almost there — wrapping up the final checks now." },
  ];
  let elapsedTimer = null;

  function startElapsedTimer() {
    const elapsedEl = document.getElementById("scanElapsed");
    const noteEl = document.getElementById("scanNote");
    const scanStart = Date.now();
    let lastThresholdIdx = -1;

    stopElapsedTimer();
    elapsedTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - scanStart) / 1000);

      // Hard safety net: nothing in this app should ever legitimately run
      // past POLL_MAX_MS (5 min). If this ever fires, some other code path
      // has a bug — stop the timer here rather than silently ticking up
      // into an absurd, misleading multi-hour display.
      if (secs > 320) {
        stopElapsedTimer();
        if (noteEl) noteEl.textContent = "This is taking unusually long. Please refresh and try again.";
        return;
      }

      if (elapsedEl) {
        const m = Math.floor(secs / 60);
        const s = String(secs % 60).padStart(2, "0");
        elapsedEl.textContent = `${m}:${s} elapsed`;
      }
      for (let i = SCAN_NOTE_THRESHOLDS.length - 1; i >= 0; i--) {
        if (secs >= SCAN_NOTE_THRESHOLDS[i].atSeconds && i > lastThresholdIdx) {
          lastThresholdIdx = i;
          if (noteEl) noteEl.textContent = SCAN_NOTE_THRESHOLDS[i].text;
          break;
        }
      }
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  // ---- Animated SVG tip carousel (fills the 3-4 min wait productively) ----
  // Each tip is a small looping SVG animation + one-line caption. Every card
  // stays on screen ~17s (within the requested 15-20s range) before a
  // crossfade to the next; the individual SVG animations loop continuously
  // underneath regardless of the carousel's own timing.
  const TIP_CARDS = [
    {
      caption: "Search is shifting from blue links to AI-generated answers.",
      svg: `<svg viewBox="0 0 160 96" xmlns="http://www.w3.org/2000/svg">
        <g style="animation: s1Pulse 2.6s ease-in-out infinite;">
          <rect x="8" y="20" width="46" height="7" rx="3.5" fill="#5b6b8c"/>
          <rect x="8" y="35" width="60" height="7" rx="3.5" fill="#5b6b8c"/>
          <rect x="8" y="50" width="38" height="7" rx="3.5" fill="#5b6b8c"/>
        </g>
        <path d="M80 42 L102 42" stroke="#5b6b8c" stroke-width="2"/>
        <path d="M96 37 L102 42 L96 47" fill="none" stroke="#5b6b8c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <g style="animation: s1PulseIn 2.6s ease-in-out infinite;">
          <path d="M112 20 h34 a8 8 0 0 1 8 8 v18 a8 8 0 0 1 -8 8 h-20 l-8 10 v-10 h-6 a8 8 0 0 1 -8 -8 v-18 a8 8 0 0 1 8 -8 z" fill="#14213f"/>
          <circle cx="122" cy="37" r="2.4" fill="#2fd1c3"/>
          <circle cx="131" cy="37" r="2.4" fill="#2fd1c3"/>
          <circle cx="140" cy="37" r="2.4" fill="#2fd1c3"/>
        </g>
      </svg>`,
    },
    {
      caption: "Structured data (schema) helps AI engines understand and cite your content directly.",
      svg: `<svg viewBox="0 0 160 96" xmlns="http://www.w3.org/2000/svg">
        <text x="28" y="58" font-family="monospace" font-size="30" fill="#5b6b8c" opacity="0.5">&lt;</text>
        <text x="118" y="58" font-family="monospace" font-size="30" fill="#5b6b8c" opacity="0.5">&gt;</text>
        <line x1="55" y1="30" x2="80" y2="55" stroke="#14213f" stroke-width="2"/>
        <line x1="105" y1="30" x2="80" y2="55" stroke="#14213f" stroke-width="2"/>
        <circle cx="55" cy="30" r="7" fill="#2fd1c3" style="transform-box: fill-box; transform-origin: center; animation: s1NodePulse 2.4s ease-in-out infinite;"/>
        <circle cx="80" cy="55" r="7" fill="#1a9b90" style="transform-box: fill-box; transform-origin: center; animation: s1NodePulse 2.4s ease-in-out infinite 0.3s;"/>
        <circle cx="105" cy="30" r="7" fill="#2fd1c3" style="transform-box: fill-box; transform-origin: center; animation: s1NodePulse 2.4s ease-in-out infinite 0.6s;"/>
      </svg>`,
    },
    {
      caption: "AI engines lean on consistent name, address, and phone signals for local recommendations.",
      svg: `<svg viewBox="0 0 160 96" xmlns="http://www.w3.org/2000/svg">
        <circle cx="80" cy="46" r="10" fill="none" stroke="#2fd1c3" stroke-width="2" style="transform-box: fill-box; transform-origin: center; animation: s1Ring 2.4s ease-out infinite;"/>
        <circle cx="80" cy="46" r="10" fill="none" stroke="#2fd1c3" stroke-width="2" style="transform-box: fill-box; transform-origin: center; animation: s1Ring 2.4s ease-out infinite 0.8s;"/>
        <circle cx="80" cy="46" r="10" fill="none" stroke="#2fd1c3" stroke-width="2" style="transform-box: fill-box; transform-origin: center; animation: s1Ring 2.4s ease-out infinite 1.6s;"/>
        <path d="M80 26 c-9 0 -16 7 -16 16 c0 11 16 28 16 28 s16 -17 16 -28 c0 -9 -7 -16 -16 -16 z" fill="#14213f"/>
        <circle cx="80" cy="42" r="5" fill="#fff"/>
      </svg>`,
    },
    {
      caption: "FAQ-style content is easier for AI engines to extract as a direct answer.",
      svg: `<svg viewBox="0 0 160 96" xmlns="http://www.w3.org/2000/svg">
        <rect x="55" y="12" width="50" height="72" rx="4" fill="#fff" stroke="#dbe1ea" stroke-width="2"/>
        <rect x="63" y="24" width="12" height="12" rx="2" fill="#e2743f" style="transform-box: fill-box; transform-origin: center; animation: s1NodePulse 3s ease-in-out infinite;"/>
        <text x="66" y="33" font-family="sans-serif" font-size="9" fill="#fff" font-weight="bold">Q</text>
        <rect x="80" y="26" width="18" height="4" rx="2" fill="#5b6b8c" opacity="0.5"/>
        <rect x="63" y="46" width="12" height="12" rx="2" fill="#2fd1c3" style="transform-box: fill-box; transform-origin: center; animation: s1NodePulse 3s ease-in-out infinite 1.2s;"/>
        <text x="66" y="55" font-family="sans-serif" font-size="9" fill="#14213f" font-weight="bold">A</text>
        <rect x="80" y="48" width="18" height="4" rx="2" fill="#5b6b8c" opacity="0.5"/>
        <rect x="80" y="56" width="14" height="4" rx="2" fill="#5b6b8c" opacity="0.3"/>
      </svg>`,
    },
    {
      caption: "Fresh, regularly updated content signals ongoing relevance to AI crawlers.",
      svg: `<svg viewBox="0 0 160 96" xmlns="http://www.w3.org/2000/svg">
        <rect x="55" y="24" width="50" height="44" rx="5" fill="#fff" stroke="#dbe1ea" stroke-width="2"/>
        <rect x="55" y="24" width="50" height="12" rx="5" fill="#14213f"/>
        <line x1="66" y1="18" x2="66" y2="30" stroke="#14213f" stroke-width="3" stroke-linecap="round"/>
        <line x1="94" y1="18" x2="94" y2="30" stroke="#14213f" stroke-width="3" stroke-linecap="round"/>
        <rect x="63" y="44" width="8" height="8" rx="1.5" fill="#2fd1c3" style="animation: s1Blink 2.2s ease-in-out infinite;"/>
        <rect x="76" y="44" width="8" height="8" rx="1.5" fill="#dbe1ea"/>
        <rect x="89" y="44" width="8" height="8" rx="1.5" fill="#dbe1ea"/>
        <path d="M113 44 a9 9 0 1 1 -3 -6.7" fill="none" stroke="#e2743f" stroke-width="3" stroke-linecap="round" style="transform-origin: 109px 40px; animation: s1Rotate 2.4s linear infinite;"/>
        <path d="M113 33 l0 8 l-8 0 z" fill="#e2743f" style="transform-origin: 109px 40px; animation: s1Rotate 2.4s linear infinite;"/>
      </svg>`,
    },
    {
      caption: "A slow-loading homepage gets crawled less often — and cited less often.",
      svg: `<svg viewBox="0 0 160 96" xmlns="http://www.w3.org/2000/svg">
        <path d="M40 66 A40 40 0 0 1 120 66" fill="none" stroke="#dbe1ea" stroke-width="10" stroke-linecap="round"/>
        <path d="M40 66 A40 40 0 0 1 80 26" fill="none" stroke="#e2743f" stroke-width="10" stroke-linecap="round" opacity="0.7"/>
        <path d="M80 26 A40 40 0 0 1 120 66" fill="none" stroke="#2fd1c3" stroke-width="10" stroke-linecap="round" opacity="0.9"/>
        <circle cx="80" cy="66" r="5" fill="#14213f"/>
        <line x1="80" y1="66" x2="60" y2="42" stroke="#14213f" stroke-width="3" stroke-linecap="round" style="transform-origin: 80px 66px; animation: s1Needle 2.8s ease-in-out infinite;"/>
      </svg>`,
    },
  ];

  const TIP_DISPLAY_MS = 17000;
  let tipTimer = null;

  function renderTip(i) {
    const visual = document.getElementById("tipVisual");
    const caption = document.getElementById("tipCaption");
    if (!visual || !caption) return;
    visual.innerHTML = TIP_CARDS[i].svg;
    caption.textContent = TIP_CARDS[i].caption;
  }

  function startTipCarousel() {
    const carousel = document.getElementById("tipCarousel");
    let i = 0;
    renderTip(0);
    stopTipCarousel();
    tipTimer = setInterval(() => {
      if (carousel) carousel.classList.add("fade");
      setTimeout(() => {
        i = (i + 1) % TIP_CARDS.length;
        renderTip(i);
        if (carousel) carousel.classList.remove("fade");
      }, 450);
    }, TIP_DISPLAY_MS);
  }

  function stopTipCarousel() {
    if (tipTimer) {
      clearInterval(tipTimer);
      tipTimer = null;
    }
  }


  // Backend worst case is roughly INSITES_MAX_WAIT_MS (default 200s) + a
  // built-in-scanner fallback (~15-20s) ≈ 220s (~3.7 min), matching the
  // "3-4 minutes" expectation set on the entry page. 5 minutes gives a
  // comfortable safety margin so normal latency never trips a false
  // "taking too long" error while a real scan is still finishing.
  const POLL_MAX_MS = 5 * 60 * 1000;

  // Backs up the "keep this tab open" copy with an actual browser prompt —
  // most browsers won't show this custom text (they show a generic native
  // message instead), but triggering the confirmation dialog at all is
  // what matters here.
  function beforeUnloadHandler(e) {
    e.preventDefault();
    e.returnValue = "";
    return "";
  }

  function startScanGuards() {
    startChecklistLoop();
    startTipCarousel();
    startElapsedTimer();
    window.addEventListener("beforeunload", beforeUnloadHandler);
  }

  function stopScanGuards() {
    stopChecklistLoop();
    stopTipCarousel();
    stopElapsedTimer();
    window.removeEventListener("beforeunload", beforeUnloadHandler);
  }

  async function runScan(rawUrl) {
    document.getElementById("scanDomain").textContent = rawUrl.replace(/^https?:\/\//, "");
    const note = document.getElementById("scanNote");
    if (note) note.textContent = "";
    showStep("scanning");
    startScanGuards();

    let scanId;
    try {
      // Generous timeout here: this is the request that wakes a sleeping
      // Render free-tier instance, which alone can take 30-50s.
      const started = await postJSON("/api/scan", { url: rawUrl }, 60000);
      scanId = started.scanId;
    } catch (e) {
      stopScanGuards();
      showError(e.message);
      return;
    }

    const deadline = Date.now() + POLL_MAX_MS;
    const MAX_CONSECUTIVE_FAILURES = 4;
    let consecutiveFailures = 0;

    const poll = async () => {
      if (Date.now() > deadline) {
        stopScanGuards();
        showError("The scan is taking longer than expected. Please try again in a few minutes.");
        return;
      }
      let status;
      try {
        status = await requestJSON(`/api/scan/${scanId}/status`, { timeoutMs: 15000 });
        consecutiveFailures = 0;
      } catch (e) {
        // A single flaky request over a multi-minute polling window
        // shouldn't kill an otherwise-healthy scan — retry a few times
        // before giving up. The overall deadline above is still the hard
        // ceiling regardless of how these retries go.
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stopScanGuards();
          showError(e.message || "Lost connection to the scan. Please try again.");
          return;
        }
        setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }
      if (status.status === "running") {
        setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }
      stopScanGuards();
      if (status.status === "error") {
        showError(status.error || "Scan failed. Please try again.");
        return;
      }
      console.info(`[Smart 1 AI Scan v${APP_VERSION}] scan complete`, status);
      renderTeaser(Object.assign({ scanId }, status));
    };
    // Poll immediately. The audit may already be complete by the time
    // POST /api/scan returns (cached/existing Insites reports often finish
    // in only a few seconds), so there is no reason to wait before asking.
    poll();
  }

  // ---- Step 2: teaser + gauge ---------------------------------------------
  function tierArcOffset(score) {
    const pct = Math.max(0, Math.min(100, score)) / 100;
    return 283 - 283 * pct;
  }

  function needleAngle(score) {
    const pct = Math.max(0, Math.min(100, score)) / 100;
    return -90 + 180 * pct;
  }

  let currentScanId = null;
  let currentEngine = null;

  function renderTeaser(data) {
    currentScanId = data.scanId;
    currentEngine = data.engine;

    document.getElementById("teaserDomain").textContent = data.domain;
    document.getElementById("scoreValue").textContent = data.score;
    document.getElementById("tierLabel").textContent = data.tier + " AI VISIBILITY";
    document.getElementById("teaserFinding").textContent = data.teaserFinding;
    document.getElementById("gapCount").textContent = Math.max(data.gapCount - 1, 0);

    document.querySelector('input[name="scanId"]').value = data.scanId;
    document.querySelector('input[name="website"]').value = data.domain;

    const competitorRow = document.getElementById("competitorRow");
    if (competitorRow) competitorRow.hidden = data.engine !== "insites";

    showStep("teaser");

    requestAnimationFrame(() => {
      const fill = document.getElementById("gaugeFill");
      const needle = document.getElementById("gaugeNeedle");
      fill.style.strokeDashoffset = tierArcOffset(data.score);
      needle.style.transform = `rotate(${needleAngle(data.score)}deg)`;
    });
  }

  // ---- Step 2b: lead capture -----------------------------------------------
  const leadForm = document.getElementById("leadForm");
  leadForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showStep("unlocking");

    const fd = new FormData(leadForm);
    const lead = Object.fromEntries(fd.entries());

    try {
      const report = await postJSON("/api/unlock", {
        scanId: currentScanId,
        lead,
      });
      renderReport(report);
      if (lead.competitorWebsite && report.competitorAvailable) {
        runCompetitorComparison(lead.competitorWebsite);
      }
    } catch (err) {
      showError(err.message);
    }
  });

  // ---- Step 4: full report ---------------------------------------------------
  let currentReportScore = null;

  function renderReport(data) {
    currentReportScore = data.score;

    document.getElementById("reportHeadline").textContent = data.headline;
    document.getElementById("reportSummary").textContent = data.summary;

    const gapsList = document.getElementById("gapsList");
    gapsList.innerHTML = "";
    (data.gaps && data.gaps.length ? data.gaps : data.findings || []).forEach((g) => {
      const li = document.createElement("li");
      li.textContent = g;
      gapsList.appendChild(li);
    });

    // "Would AI cite you?" checklist
    if (data.citationChecklist) {
      document.getElementById("citationHeadline").textContent = data.citationChecklist.headline;
      const list = document.getElementById("citationList");
      list.innerHTML = "";
      data.citationChecklist.items.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item.label;
        li.className = item.pass ? "pass" : "fail";
        list.appendChild(li);
      });
    }

    // Score projection bar
    const projected = parseProjectionRange(data.package.projectedScoreRange);
    document.getElementById("projectionNow").textContent = `${data.score}/100`;
    document.getElementById("projectionTarget").textContent = `${data.package.projectedScoreRange}/100`;
    requestAnimationFrame(() => {
      const fill = document.getElementById("projectionFill");
      const nowMarker = document.getElementById("projectionNowMarker");
      const targetMarker = document.getElementById("projectionTargetMarker");
      const nowPct = Math.max(2, Math.min(98, data.score));
      const targetPct = Math.max(2, Math.min(98, projected.high));
      fill.style.width = targetPct + "%";
      nowMarker.style.left = nowPct + "%";
      targetMarker.style.left = targetPct + "%";
    });

    document.getElementById("packageName").textContent = data.package.name;
    document.getElementById("packageReason").textContent = data.package.reason;
    document.getElementById("packageSetup").textContent = data.package.setupInvestment;
    document.getElementById("packageMonthly").textContent = data.package.monthlyInvestment;
    document.getElementById("packageEffort").textContent = data.package.monthlyEffort || "";

    const bookBtn = document.getElementById("bookCallBtn");
    bookBtn.href = data.bookingUrl || "#";
    if (data.ctaLabel) document.getElementById("bookCallLabel").textContent = data.ctaLabel;

    let crmNote = data.crmForwarded
      ? "Your results have been sent to a Smart 1 strategist."
      : "Your report is ready. A Smart 1 strategist will follow up shortly.";
    if (data.emailRequested && data.crmForwarded) {
      crmNote += " A copy will be emailed to you shortly.";
    }
    document.getElementById("crmNote").textContent = crmNote;

    const pdfLink = document.getElementById("viewPdfLink");
    if (pdfLink) {
      if (data.reportPdfUrl) {
        pdfLink.href = data.reportPdfUrl;
        pdfLink.hidden = false;
      } else {
        pdfLink.hidden = true;
      }
    }

    // Competitor comparison entry point
    const competitorForm = document.getElementById("competitorForm");
    if (competitorForm) competitorForm.hidden = !data.competitorAvailable;

    showStep("report");
  }

  function parseProjectionRange(rangeStr) {
    // "65–85" -> { low: 65, high: 85 }
    const parts = String(rangeStr || "").split(/[–-]/).map((n) => parseInt(n, 10));
    return {
      low: Number.isFinite(parts[0]) ? parts[0] : 0,
      high: Number.isFinite(parts[1]) ? parts[1] : Number.isFinite(parts[0]) ? parts[0] : 100,
    };
  }

  // ---- Competitor comparison -------------------------------------------------
  async function runCompetitorComparison(competitorUrl) {
    const panel = document.getElementById("competitorPanel");
    const note = document.getElementById("competitorNote");
    const form = document.getElementById("competitorForm");

    panel.hidden = false;
    if (form) form.hidden = true;
    document.getElementById("competitorYouScore").textContent = currentReportScore ?? "—";
    document.getElementById("competitorTheirScore").textContent = "…";
    document.getElementById("competitorTheirLabel").textContent = competitorUrl.replace(/^https?:\/\//, "");
    note.textContent = "Running comparison audit — this can take a minute…";

    let competitorScanId;
    try {
      const started = await postJSON("/api/competitor", { scanId: currentScanId, competitorUrl });
      competitorScanId = started.competitorScanId;
    } catch (err) {
      note.textContent = err.message || "Couldn't start that comparison.";
      return;
    }

    const deadline = Date.now() + POLL_MAX_MS;
    const MAX_CONSECUTIVE_FAILURES = 4;
    let consecutiveFailures = 0;

    const pollCompetitor = async () => {
      if (Date.now() > deadline) {
        note.textContent = "Comparison timed out — try again in a moment.";
        return;
      }
      let status;
      try {
        status = await requestJSON(`/api/competitor/${competitorScanId}/status`, { timeoutMs: 15000 });
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          note.textContent = err.message || "Comparison failed.";
          return;
        }
        setTimeout(pollCompetitor, POLL_INTERVAL_MS);
        return;
      }
      if (status.status === "running") {
        setTimeout(pollCompetitor, POLL_INTERVAL_MS);
        return;
      }
      if (status.status === "error") {
        note.textContent = status.error || "Couldn't complete that comparison.";
        return;
      }
      document.getElementById("competitorTheirScore").textContent = status.score;
      document.getElementById("competitorTheirLabel").textContent = status.domain;
      const diff = (currentReportScore ?? 0) - status.score;
      note.textContent =
        diff > 0
          ? `You're ahead by ${diff} points.`
          : diff < 0
          ? `${status.domain} is ahead by ${-diff} points — this is exactly the gap Smart 1 closes.`
          : "You're currently tied.";
    };
    setTimeout(pollCompetitor, POLL_INTERVAL_MS);
  }

  const competitorForm = document.getElementById("competitorForm");
  if (competitorForm) {
    competitorForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(competitorForm);
      const competitorUrl = fd.get("competitorUrl");
      if (!competitorUrl) return;
      competitorForm.querySelector("button").disabled = true;
      runCompetitorComparison(competitorUrl);
    });
  }
})();
