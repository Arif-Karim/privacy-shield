const STATUS_TEXT = {
  green: "Looks safe — no strong signal of sharing/selling your data.",
  yellow: "Not sure — couldn't confirm either way.",
  red: "Caution — this site may share or sell your data.",
};

const REPORT_EMAIL = "arifjubairulkarim@gmail.com";

let currentTab = null;
let latestResult = null;

function renderReasons(source, reasons) {
  const list = document.getElementById("reasons");
  list.innerHTML = "";
  for (const reason of reasons || []) {
    const li = document.createElement("li");
    // Heuristic red/green reasons are sentences quoted verbatim from the
    // site's own policy ("we may share...") — attribute them clearly so it
    // doesn't read as Privacy Shield making that statement about itself.
    const isQuote = source === "heuristic" && (reason.signal === "red" || reason.signal === "green");
    li.textContent = isQuote ? `Their privacy policy: "${reason.label}"` : reason.label;
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
    const { rating, source, reasons } = result;
    dot.classList.add(rating);
    status.textContent = STATUS_TEXT[rating] + (source === "tosdr" ? " (via ToS;DR)" : " (via keyword scan)");
    renderReasons(source, reasons);
  }

  document.getElementById("reportBtn").addEventListener("click", handleReportClick);
}

main();
