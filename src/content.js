// Active trigger: watches the page for inputs that collect a phone number and
// kicks off a rating for the site. Email-only forms (newsletters, sign-ups)
// deliberately don't trigger anything — the risk this extension targets is
// your number ending up with companies that will call you.

const LOG = "[Privacy Shield]";
const PHONE_SELECTOR = 'input[type="tel"]';
const PHONE_HINT_RE = /phone|mobile|cellular|\btel\b|telephone/i;

const BANNER_ID = "privacy-shield-banner";
const BANNER_STYLE = {
  red: { bg: "#dc2626", title: "Privacy Shield: this site may sell your number or pass it to companies that will contact you." },
  unknown: { bg: "#475569", title: "Privacy Shield: couldn't check this site's privacy policy — have a look yourself before sharing your number." },
};
// Headline overrides for specific "unknown" reasons.
const UNKNOWN_TITLES = {
  no_policy_link: "Privacy Shield: this page doesn't link to a privacy policy.",
  quota: "Privacy Shield: this site hasn't been checked yet — you've used this month's free checks.",
};

// Auto-dismiss delay per rating — "unknown" gets the longest since it asks
// the reader to go check something themselves.
const AUTO_DISMISS_MS = { red: 14000, unknown: 20000 };

let scanTriggered = false;
let lastPrivacyPolicyUrl = null;
let lastResult = null;
let phoneEnteredBeforeResult = false;

function looksLikePhoneInput(input) {
  if (input.type === "hidden" || input.type === "submit" || input.type === "button") return false;
  if (input.matches(PHONE_SELECTOR)) return true;
  const hints = [input.name, input.id, input.autocomplete, input.placeholder, input.getAttribute("aria-label")].join(" ");
  return PHONE_HINT_RE.test(hints);
}

function findPrivacyPolicyUrl() {
  const links = Array.from(document.querySelectorAll("a[href]"));
  const match = links.find((a) => /privacy( policy)?/i.test(a.textContent || "") || /privacy-?policy/i.test(a.getAttribute("href") || ""));
  return match ? match.href : null;
}

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function el(tag, cssText, text) {
  const node = document.createElement(tag);
  if (cssText) node.style.cssText = cssText;
  // Always textContent, never innerHTML: quoted policy text comes from a
  // third-party page and must not be able to inject markup into this page.
  if (text) node.textContent = text;
  return node;
}

// One banner builder for ratings and alerts. `opts`: {bg, title, detail,
// list, policyUrl, dismissMs}.
function renderBanner(opts) {
  if (document.getElementById(BANNER_ID)) return;

  const banner = el("div", `
    position: fixed; top: 12px; right: 12px; z-index: 2147483647;
    max-width: 360px; padding: 12px 36px 12px 14px; border-radius: 8px;
    background: ${opts.bg}; color: #fff; font: 13px/1.4 -apple-system, system-ui, sans-serif;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  `);
  banner.id = BANNER_ID;
  banner.appendChild(el("div", "font-weight:600; margin-bottom:4px;", opts.title));
  if (opts.detail) banner.appendChild(el("div", "opacity:0.92; font-size:12px;", opts.detail));
  if (opts.list && opts.list.length) {
    const list = el("ul", "margin:6px 0 0; padding-left:16px; font-size:12px; opacity:0.95;");
    for (const item of opts.list) list.appendChild(el("li", "margin-bottom:3px;", item));
    banner.appendChild(list);
  }

  // Link to the site's own privacy policy (not Privacy Shield's) so the
  // reader can check it themselves.
  if (opts.policyUrl && isSafeHttpUrl(opts.policyUrl)) {
    const link = el("a", "display:inline-block; margin-top:8px; color:#fff; font-size:12px; text-decoration:underline;", "Read their full privacy policy ↗");
    link.href = opts.policyUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    banner.appendChild(link);
  }

  const closeBtn = el("button", `
    position: absolute; top: 6px; right: 8px; background: transparent; border: none;
    color: #fff; font-size: 18px; line-height: 1; cursor: pointer; padding: 4px;
  `, "×");
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.onclick = () => banner.remove();
  banner.appendChild(closeBtn);

  document.documentElement.appendChild(banner);
  setTimeout(() => banner.remove(), opts.dismissMs);
}

function showRatingBanner(result) {
  const style = BANNER_STYLE[result.rating];
  if (!style) return;
  // Quoted evidence is in the site's own voice ("we may share..."), so
  // attribute it clearly — otherwise it reads as Privacy Shield saying it.
  const quote = result.quoted_evidence && result.quoted_evidence[0];
  renderBanner({
    bg: style.bg,
    title: UNKNOWN_TITLES[result.reason] || style.title,
    detail: result.rating === "red" ? (quote ? `Their privacy policy: "${quote}"` : result.reasoning) : null,
    list: result.rating === "unknown" ? result.guidance : null,
    policyUrl: result.policyUrl || lastPrivacyPolicyUrl,
    dismissMs: AUTO_DISMISS_MS[result.rating],
  });
}

const ALERT_OUTCOME = {
  red: "may sell your number or pass it to companies that will contact you",
  yellow: "may call or text you themselves, or is unclear about who gets your data",
};

function showPolicyChangeAlert(alert) {
  const when = new Date(alert.enteredAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  renderBanner({
    bg: "#7f1d1d",
    title: `Privacy Shield alert: ${alert.ratedDomain} changed its privacy policy.`,
    detail: `You gave them your phone number on ${when}. Their policy now says they ${ALERT_OUTCOME[alert.to] || "handle your data differently"}.` +
      (alert.quote ? ` Their privacy policy: "${alert.quote}"` : ""),
    policyUrl: alert.policyUrl,
    dismissMs: 30000,
  });
}

function triggerScan() {
  if (scanTriggered) return;
  scanTriggered = true;

  const privacyPolicyUrl = findPrivacyPolicyUrl();
  lastPrivacyPolicyUrl = privacyPolicyUrl;
  console.log(LOG, "phone input detected, requesting rating. domain:", location.hostname, "privacyPolicyUrl:", privacyPolicyUrl);

  chrome.runtime.sendMessage(
    { type: "SCAN_REQUEST", domain: location.hostname, privacyPolicyUrl },
    (result) => {
      if (chrome.runtime.lastError) {
        console.warn(LOG, "scan request failed:", chrome.runtime.lastError.message);
        return;
      }
      console.log(LOG, "rating:", result);
      lastResult = result;
      if (phoneEnteredBeforeResult) reportPhoneEntered();
      // Interrupt only when it matters: red (your number may reach companies
      // that will contact you) or unknown (we couldn't check, so the reader
      // should). Yellow/green show on the toolbar icon only.
      if (result.rating === "red" || result.rating === "unknown") {
        showRatingBanner(result);
      }
    }
  );
}

function scanForPhoneInputs() {
  for (const input of document.querySelectorAll("input")) {
    if (looksLikePhoneInput(input)) {
      triggerScan();
      return;
    }
  }
}

// The user actually typed a number (not just saw the field). Only the site
// and its rating are recorded, in the extension's local storage — never the
// number itself. Used by the paid policy-change alerts.
function reportPhoneEntered() {
  if (!lastResult) {
    phoneEnteredBeforeResult = true;
    return;
  }
  phoneEnteredBeforeResult = false;
  chrome.runtime.sendMessage({ type: "PHONE_ENTERED", result: lastResult });
}

document.addEventListener(
  "change",
  (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && looksLikePhoneInput(input) && input.value.replace(/\D/g, "").length >= 7) {
      reportPhoneEntered();
    }
  },
  true
);

scanForPhoneInputs();

// Pending policy-change alerts are shown once, on the next page opened (top
// frame only, so an alert never renders inside an embedded iframe).
if (window === window.top) {
  chrome.runtime.sendMessage({ type: "GET_PENDING_ALERT" }, (alert) => {
    if (chrome.runtime.lastError || !alert || alert.error) return;
    showPolicyChangeAlert(alert);
  });
}

const observer = new MutationObserver(() => {
  if (!scanTriggered) scanForPhoneInputs();
});
observer.observe(document.documentElement, { childList: true, subtree: true });

// Live diagnostic snapshot of this frame, used by the popup's "report an
// issue" button — re-checks right now rather than relying only on history,
// since the user may click report on a page that never triggered a scan.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GET_DIAGNOSTICS") return;
  const phoneInputNow = Array.from(document.querySelectorAll("input")).some(looksLikePhoneInput);
  sendResponse({
    frameUrl: location.href,
    scanTriggered,
    phoneInputDetectedNow: phoneInputNow,
    privacyPolicyUrlUsed: lastPrivacyPolicyUrl,
    privacyPolicyUrlNow: findPrivacyPolicyUrl(),
    iframeCount: document.querySelectorAll("iframe").length,
  });
});
