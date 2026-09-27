const STATUS_TEXT = {
  green: "Looks safe — your details only go to companies working for this site.",
  yellow: "Some caution — the site may call or text you itself, or its policy is unclear about who gets your data.",
  red: "Warning — this site may sell your number or pass it to companies that will contact you.",
  unknown: "Couldn't check this site's privacy policy automatically. Here's what to look for:",
};

const UNKNOWN_REASON_TEXT = {
  no_policy_link: "This page doesn't link to a privacy policy.",
  unreadable: "The site blocked us from reading its privacy policy.",
  not_a_policy: "The privacy link doesn't lead to an actual privacy policy.",
  busy: "Too many new sites checked today — try again later.",
  backend_unavailable: "Privacy Shield's server couldn't be reached.",
};

const REPORT_EMAIL = "arifjubairulkarim@gmail.com";

let currentTab = null;
let latestResult = null;

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function renderList(items) {
  const list = document.getElementById("reasons");
  list.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
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
    "Describe what went wrong (e.g. \"no warning appeared even though the form asks for my phone number\"):",
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
          `Top-frame phone input detected right now: ${diag.phoneInputDetectedNow}`,
          `Top-frame privacy policy link (used at scan time): ${diag.privacyPolicyUrlUsed || "none found"}`,
          `Top-frame privacy policy link (right now): ${diag.privacyPolicyUrlNow || "none found"}`,
          `Iframes on page: ${diag.iframeCount}`,
        ].join("\n"),
    "",
    result
      ? `Last rating shown: ${result.rating}${result.reason ? ` (${result.reason})` : ""} for ${result.ratedDomain || "?"}\nReasoning: ${result.reasoning || "-"}`
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

  const pageDomain = new URL(tab.url).hostname;
  document.getElementById("domain").textContent = pageDomain;

  const result = await chrome.runtime.sendMessage({ type: "GET_LATEST", tabId: tab.id });
  latestResult = result;

  const dot = document.getElementById("dot");
  const status = document.getElementById("status");
  const note = document.getElementById("note");

  if (!result) {
    status.textContent = "No phone number field detected on this page yet.";
  } else {
    dot.classList.add(result.rating);
    status.textContent = STATUS_TEXT[result.rating] || STATUS_TEXT.unknown;

    const notes = [];
    if (result.rating === "unknown" && UNKNOWN_REASON_TEXT[result.reason]) notes.push(UNKNOWN_REASON_TEXT[result.reason]);
    // Forms embedded from another company (quote widgets etc.) are rated by
    // the privacy policy they link to — say whose policy that was.
    if (result.ratedDomain && result.ratedDomain !== pageDomain.replace(/^www\./, "")) notes.push(`Based on ${result.ratedDomain}'s privacy policy.`);
    if (result.outdated) notes.push("Their policy changed recently and hasn't been re-checked yet.");
    note.textContent = notes.join(" ");

    if (result.rating === "unknown") {
      renderList(result.guidance || []);
    } else if (result.quoted_evidence && result.quoted_evidence.length) {
      // Quotes are in the site's own voice ("we may share..."); attribute them
      // so they don't read as Privacy Shield's statements.
      renderList(result.quoted_evidence.slice(0, 3).map((q) => `Their privacy policy: "${q}"`));
    } else if (result.reasoning) {
      renderList([result.reasoning]);
    }

    const link = document.getElementById("policyLink");
    if (result.policyUrl && isSafeHttpUrl(result.policyUrl)) {
      link.href = result.policyUrl;
      link.hidden = false;
    }
  }

  document.getElementById("reportBtn").addEventListener("click", handleReportClick);
}

main();
