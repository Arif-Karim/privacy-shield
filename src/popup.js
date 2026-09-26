const STATUS_TEXT = {
  green: "Looks safe — no strong signal of sharing/selling your data.",
  yellow: "Mixed signal — may share data for routine operations, but no sign of third-party solicitation.",
  red: "Caution — this site may share or sell your data to parties who'll contact you directly.",
};

const REPORT_EMAIL = "arifjubairulkarim@gmail.com";

let currentTab = null;
let latestResult = null;

function renderReasons(source, reasons, basedOn) {
  const list = document.getElementById("reasons");
  list.innerHTML = "";
  for (const reason of reasons || []) {
    const li = document.createElement("li");
    // Heuristic/LLM red/amber/green reasons quoted from the site's own
    // policy ("we may share...") get attributed clearly so it doesn't read
    // as Privacy Shield making that statement about itself. LLM answers with
    // no policy page found are inferences, not citations — labeled as such.
    let text;
    if (source === "heuristic" && (reason.signal === "red" || reason.signal === "amber" || reason.signal === "green")) {
      text = `Their privacy policy: "${reason.label}"`;
    } else if (source === "llm" && basedOn === "policy_text") {
      text = `Their privacy policy: "${reason.label}"`;
    } else if (source === "llm" && basedOn === "general_knowledge") {
      text = `No privacy policy found — based on general knowledge: ${reason.label}`;
    } else {
      text = reason.label;
    }
    li.textContent = text;
    list.appendChild(li);
  }
}

function getDiagnostics(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "GET_DIAGNOSTICS" }, { frameId: 0 }, (diag) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(diag || { error: "no response from page" });
    });
  });
}

function buildReportBody(tab, diag, result) {
  const lines = [
    "Describe what went wrong (e.g. \"no banner appeared even though there's an email field\"):",
    "",
    "",
    "--- diagnostics (auto-collected, please leave below) ---",
    `Page URL: ${tab.url}`,
    `Timestamp: ${new Date().toISOString()}`,
    `Extension version: ${chrome.runtime.getManifest().version}`,
    `User agent: ${navigator.userAgent}`,
    "",
    diag.error
      ? `Top-frame diagnostics: unavailable (${diag.error})`
      : [
          `Top-frame scan triggered: ${diag.scanTriggered}`,
          `Top-frame PII input detected right now: ${diag.piiInputDetectedNow}`,
          `Top-frame privacy policy link (used at scan time): ${diag.privacyPolicyUrlUsed || "none found"}`,
          `Top-frame privacy policy link (right now): ${diag.privacyPolicyUrlNow || "none found"}`,
          `Iframes on page: ${diag.iframeCount}`,
        ].join("\n"),
    "",
    result
      ? `Last rating shown: ${result.rating} (source: ${result.source || "tosdr"})\nReasons: ${JSON.stringify(result.reasons)}`
      : "Last rating shown: none — no scan result recorded for this tab.",
  ];
  return lines.join("\n");
}

async function handleReportClick() {
  const status = document.getElementById("reportStatus");
  const btn = document.getElementById("reportBtn");
  if (!currentTab) return;

  btn.disabled = true;
  status.textContent = "Gathering details…";

  const diag = await getDiagnostics(currentTab.id);
  const domain = new URL(currentTab.url).hostname;
  const subject = `Privacy Shield issue report: ${domain}`;
  const body = buildReportBody(currentTab, diag, latestResult);
  const mailtoUrl = `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  chrome.tabs.create({ url: mailtoUrl });
  status.textContent = "Opened a pre-filled email — please send it to report this.";
  btn.disabled = false;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || tab.id == null) return;
  currentTab = tab;

  document.getElementById("domain").textContent = new URL(tab.url).hostname;

  const result = await chrome.runtime.sendMessage({ type: "GET_LATEST", tabId: tab.id });
  latestResult = result;

  const dot = document.getElementById("dot");
  const status = document.getElementById("status");

  if (!result) {
    status.textContent = "No email/phone form detected on this page yet.";
  } else {
    const { rating, source, reasons, basedOn } = result;
    dot.classList.add(rating);
    let sourceLabel;
    if (source === "tosdr") sourceLabel = " (via ToS;DR)";
    else if (source === "llm") sourceLabel = basedOn === "general_knowledge" ? " (via AI, general knowledge)" : " (via AI analysis)";
    else sourceLabel = " (via keyword scan)";
    status.textContent = STATUS_TEXT[rating] + sourceLabel;
    renderReasons(source, reasons, basedOn);
  }

  document.getElementById("reportBtn").addEventListener("click", handleReportClick);
}

main();
