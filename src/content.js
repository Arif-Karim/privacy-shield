// Active trigger: watches the page for inputs that look like they collect an
// email or phone number, and kicks off a rating scan for the current domain.

const LOG = "[Privacy Shield]";
const PII_SELECTOR = 'input[type="email"], input[type="tel"]';
const PII_NAME_RE = /email|e-mail|phone|mobile|tel(ephone)?/i;

const BANNER_ID = "privacy-shield-banner";
const BANNER_STYLE = {
  green: { bg: "#16a34a", text: "Privacy Shield: looks safe — no strong signal this site shares/sells your data." },
  yellow: { bg: "#ca8a04", text: "Privacy Shield: not sure — couldn't confirm how this site handles your data." },
  red: { bg: "#dc2626", text: "Privacy Shield: caution — this site may share or sell your data." },
};

let scanTriggered = false;
let lastPrivacyPolicyUrl = null;

function looksLikePiiInput(input) {
  if (input.matches(PII_SELECTOR)) return true;
  const hints = [input.name, input.id, input.autocomplete, input.placeholder].join(" ");
  return PII_NAME_RE.test(hints);
}

function findPrivacyPolicyUrl() {
  const links = Array.from(document.querySelectorAll("a[href]"));
  const match = links.find((a) => /privacy( policy)?/i.test(a.textContent || "") || /privacy-?policy/i.test(a.getAttribute("href") || ""));
  return match ? match.href : null;
}

function formatReason(result) {
  const reason = result.reasons && result.reasons[0];
  if (!reason) return "";
  // Heuristic red/green reasons are sentences quoted verbatim from the site's
  // own policy (written in their voice, "we may share..."). Attribute them
  // clearly so it doesn't read as Privacy Shield making that statement.
  if (result.source === "heuristic" && (reason.signal === "red" || reason.signal === "amber" || reason.signal === "green")) {
    return `Their privacy policy: "${reason.label}"`;
  }
  if (result.source === "llm") {
    if (result.basedOn === "policy_text") return `Their privacy policy: "${reason.label}"`;
    // No policy page was found at all — be explicit this is an inference,
    // not a citation, so it doesn't read as quoted policy text.
    if (result.basedOn === "general_knowledge") return `No privacy policy found — based on general knowledge: ${reason.label}`;
  }
  return reason.label;
}

// Auto-dismiss delay per rating — red gets longer since it's the one worth
// actually reading before deciding whether to submit the form.
const AUTO_DISMISS_MS = { green: 6000, yellow: 9000, red: 14000 };

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function showBanner(result) {
  if (document.getElementById(BANNER_ID)) return;

  const style = BANNER_STYLE[result.rating] || BANNER_STYLE.yellow;
  const reasonText = formatReason(result);

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.style.cssText = `
    position: fixed; top: 12px; right: 12px; z-index: 2147483647;
    max-width: 340px; padding: 12px 36px 12px 14px; border-radius: 8px;
    background: ${style.bg}; color: #fff; font: 13px/1.4 -apple-system, system-ui, sans-serif;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  `;
  banner.innerHTML = `
    <div style="font-weight:600; margin-bottom:4px;">${style.text}</div>
    ${reasonText ? `<div style="opacity:0.9; font-size:12px;">${reasonText}</div>` : ""}
  `;

  // Link to the site's own privacy policy (not Privacy Shield's) so someone
  // who wants more than one quoted sentence before deciding whether to
  // submit the form can go read the whole thing themselves.
  if (lastPrivacyPolicyUrl && isSafeHttpUrl(lastPrivacyPolicyUrl)) {
    const link = document.createElement("a");
    link.href = lastPrivacyPolicyUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Read their full privacy policy ↗";
    link.style.cssText = "display:inline-block; margin-top:8px; color:#fff; font-size:12px; text-decoration:underline;";
    banner.appendChild(link);
  }

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.style.cssText = `
    position: absolute; top: 6px; right: 8px; background: transparent; border: none;
    color: #fff; font-size: 18px; line-height: 1; cursor: pointer; padding: 4px;
  `;
  closeBtn.onclick = () => banner.remove();
  banner.appendChild(closeBtn);

  document.documentElement.appendChild(banner);

  const dismissAfter = AUTO_DISMISS_MS[result.rating] || AUTO_DISMISS_MS.yellow;
  setTimeout(() => banner.remove(), dismissAfter);
}

function triggerScan() {
  if (scanTriggered) return;
  scanTriggered = true;

  const privacyPolicyUrl = findPrivacyPolicyUrl();
  lastPrivacyPolicyUrl = privacyPolicyUrl;
  console.log(LOG, "PII input detected, requesting scan. domain:", location.hostname, "privacyPolicyUrl:", privacyPolicyUrl);

  chrome.runtime.sendMessage(
    { type: "SCAN_REQUEST", domain: location.hostname, privacyPolicyUrl },
    (result) => {
      if (chrome.runtime.lastError) {
        console.warn(LOG, "scan request failed:", chrome.runtime.lastError.message);
        return;
      }
      console.log(LOG, "scan result:", result);
      // Only red (sell/rent, or sharing with parties who'll solicit you
      // directly) is worth interrupting for. Yellow now also covers routine
      // operational sharing (affiliates/subcontractors/vendors) which isn't
      // the "your phone starts ringing" scenario — badge still reflects it,
      // but the banner stays quiet for both yellow and green.
      if (result.rating === "red") {
        showBanner(result);
      }
    }
  );
}

function scanForPiiInputs() {
  const inputs = document.querySelectorAll("input");
  for (const input of inputs) {
    if (looksLikePiiInput(input)) {
      triggerScan();
      return;
    }
  }
}

scanForPiiInputs();

const observer = new MutationObserver(() => {
  if (!scanTriggered) scanForPiiInputs();
});
observer.observe(document.documentElement, { childList: true, subtree: true });

// Live diagnostic snapshot of this frame, used by the popup's "report an
// issue" button — re-checks right now rather than relying only on history,
// since the user may click report on a page that never triggered a scan.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GET_DIAGNOSTICS") return;
  const piiInputNow = Array.from(document.querySelectorAll("input")).some(looksLikePiiInput);
  sendResponse({
    frameUrl: location.href,
    scanTriggered,
    piiInputDetectedNow: piiInputNow,
    privacyPolicyUrlUsed: lastPrivacyPolicyUrl,
    privacyPolicyUrlNow: findPrivacyPolicyUrl(),
    iframeCount: document.querySelectorAll("iframe").length,
  });
});
