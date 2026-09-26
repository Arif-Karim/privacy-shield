import { scorePolicyText, stripHtml } from "./heuristic.js";

const LOG = "[Privacy Shield:bg]";

// Primary analysis is now an LLM call through our own backend (Cloudflare
// Worker), which caches results per-domain so most requests never actually
// hit Claude. The keyword heuristic is kept only as a last-resort fallback
// if the backend itself is unreachable — see getRating().
const BACKEND_URL = "https://privacy-shield-api.arifjubairulkarim.workers.dev/rate";
// Soft deterrent against casual abuse, not real security — anyone who
// unpacks the extension can read this. Real protection is the backend's
// domain-keyed cache + daily call cap.
const EXTENSION_SHARED_KEY = "a33e66b319417b746328055c1fe72a8a15f88fcfc6c5778862ce084cac281507";

// Rating is shown via a small corner dot baked into the icon itself (see
// icons/icon{16,48,128}-{red,yellow,green}.png), not the runtime badge API —
// chrome.action's text badge forces a minimum pill width that, on a 16px
// icon, ends up covering half the icon like an oversized stamp.
const ICON_PATHS = {
  red: { 16: "icons/icon16-red.png", 48: "icons/icon48-red.png", 128: "icons/icon128-red.png" },
  yellow: { 16: "icons/icon16-yellow.png", 48: "icons/icon48-yellow.png", 128: "icons/icon128-yellow.png" },
  green: { 16: "icons/icon16-green.png", 48: "icons/icon48-green.png", 128: "icons/icon128-green.png" },
};
const BASE_ICON_PATH = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };

// chrome.action.setIcon({path}) does its own internal fetch of the resource,
// which is unreliable from an MV3 service worker (fails with "Failed to
// fetch" even on current Chrome, not just old versions — reproduced during
// testing). Pre-decoding each icon into ImageData ourselves and calling
// setIcon({imageData}) instead sidesteps Chrome's internal fetch entirely.
async function loadImageData(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function loadIconVariant(pathsBySize) {
  const entries = await Promise.all(
    Object.entries(pathsBySize).map(async ([size, path]) => [size, await loadImageData(path)])
  );
  return Object.fromEntries(entries);
}

const iconImageDataPromise = (async () => {
  const [base, red, yellow, green] = await Promise.all([
    loadIconVariant(BASE_ICON_PATH),
    loadIconVariant(ICON_PATHS.red),
    loadIconVariant(ICON_PATHS.yellow),
    loadIconVariant(ICON_PATHS.green),
  ]);
  return { base, red, yellow, green };
})();

const TOSDR_GRADE_TO_RATING = {
  A: "green",
  B: "green",
  C: "yellow",
  D: "red",
  E: "red",
};

// No caching of ratings by design — every SCAN_REQUEST re-analyzes. This map
// just holds the current tab's latest result so the popup has something to
// show when opened; it's cleared whenever the tab navigates away.
const latestByTab = new Map();

// ToS;DR's search endpoint does a text search, not a domain-suffix lookup —
// querying with a real-world hostname like "www.tiktok.com" or
// "auth.wikimedia.org" returns zero results even though "tiktok.com" /
// "wikimedia.org" have ratings. So we try the full hostname first, then
// progressively strip the leftmost label (auth.wikimedia.org -> wikimedia.org)
// until something matches or we run out of labels.
function domainSearchCandidates(domain) {
  const labels = domain.split(".");
  const candidates = [domain];
  for (let i = 1; i < labels.length - 1; i++) {
    candidates.push(labels.slice(i).join("."));
  }
  return candidates;
}

async function tosdrSearch(query) {
  const res = await fetch(`https://api.tosdr.org/search/v5/?query=${encodeURIComponent(query)}`);
  if (!res.ok) {
    console.log(LOG, "ToS;DR responded", res.status, "for query", query);
    return null;
  }
  const data = await res.json();
  return data.services || [];
}

async function lookupTosdr(domain) {
  try {
    for (const candidate of domainSearchCandidates(domain)) {
      console.log(LOG, "querying ToS;DR for", candidate);
      const services = await tosdrSearch(candidate);
      if (!services) continue;

      const match = services.find((s) => (s.urls || []).some((u) => u === domain || domain.endsWith(`.${u}`) || u.endsWith(`.${domain}`)));
      const rating = match && match.rating && TOSDR_GRADE_TO_RATING[match.rating];
      if (rating) {
        console.log(LOG, "ToS;DR match:", match.name, "grade", match.rating, "->", rating, "(via query", candidate, ")");
        return {
          rating,
          source: "tosdr",
          reasons: [{ signal: rating, label: `ToS;DR grade ${match.rating} for ${match.name}` }],
        };
      }
    }
    console.log(LOG, "no ToS;DR-rated match for", domain, "- falling back to heuristic");
  } catch (err) {
    console.warn(LOG, "ToS;DR lookup failed:", err);
  }
  return null;
}

async function fetchPolicyText(privacyPolicyUrl) {
  const res = await fetch(privacyPolicyUrl);
  if (!res.ok) throw new Error(`privacy policy fetch failed with status ${res.status}`);
  const html = await res.text();
  return stripHtml(html);
}

// Keyword heuristic — no longer the primary analysis method (see
// analyzeWithLLM), kept only as a last-resort fallback if our own backend is
// unreachable, so the extension still says *something* rather than nothing.
async function scanPrivacyPolicy(privacyPolicyUrl) {
  try {
    console.log(LOG, "[fallback] fetching privacy policy:", privacyPolicyUrl);
    const text = await fetchPolicyText(privacyPolicyUrl);
    console.log(LOG, "[fallback] extracted", text.length, "chars of policy text; first 200:", text.slice(0, 200));
    const { rating, reasons } = scorePolicyText(text);
    console.log(LOG, "[fallback] heuristic result:", rating, reasons);
    return { rating, source: "heuristic", reasons };
  } catch (err) {
    console.warn(LOG, "[fallback] privacy policy scan failed:", err);
    return { rating: "yellow", source: "heuristic", reasons: [{ signal: "yellow", label: "couldn't fetch privacy policy page" }] };
  }
}

async function analyzeWithLLM(domain, privacyPolicyUrl) {
  let policyText = null;
  if (privacyPolicyUrl) {
    try {
      console.log(LOG, "fetching privacy policy for LLM analysis:", privacyPolicyUrl);
      policyText = await fetchPolicyText(privacyPolicyUrl);
      console.log(LOG, "extracted", policyText.length, "chars of policy text");
    } catch (err) {
      console.warn(LOG, "privacy policy fetch failed, asking LLM to use general knowledge instead:", err);
    }
  }

  const res = await fetch(BACKEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Extension-Key": EXTENSION_SHARED_KEY },
    body: JSON.stringify({ domain, policyText }),
  });
  if (!res.ok) throw new Error(`backend responded ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  console.log(LOG, "LLM rating:", data.rating, "(cached:", data.cached, ", based_on:", data.based_on, ")");

  const reasons =
    data.quoted_evidence && data.quoted_evidence.length > 0
      ? data.quoted_evidence.map((q) => ({ signal: data.rating, label: q }))
      : [{ signal: data.rating, label: data.reasoning }];

  return { rating: data.rating, source: "llm", basedOn: data.based_on, reasons };
}

async function getRating(domain, privacyPolicyUrl) {
  let result = await lookupTosdr(domain);
  if (!result) {
    try {
      result = await analyzeWithLLM(domain, privacyPolicyUrl);
    } catch (err) {
      console.warn(LOG, "LLM backend unavailable, falling back to heuristic:", err);
      result = privacyPolicyUrl
        ? await scanPrivacyPolicy(privacyPolicyUrl)
        : { rating: "yellow", source: "heuristic", reasons: [{ signal: "yellow", label: "no privacy policy link found on page" }] };
    }
  }
  console.log(LOG, "final rating for", domain, "=", result.rating, "(source:", result.source || "tosdr", ")");
  return result;
}

async function setBadge(tabId, rating) {
  try {
    const iconData = await iconImageDataPromise;
    await chrome.action.setIcon({ tabId, imageData: iconData[rating] || iconData.base });
  } catch (err) {
    console.warn(LOG, "setIcon failed for tab", tabId, "rating", rating, ":", err);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SCAN_REQUEST") {
    console.log(LOG, "SCAN_REQUEST for", message.domain, "privacyPolicyUrl:", message.privacyPolicyUrl);
    getRating(message.domain, message.privacyPolicyUrl).then((result) => {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) {
        latestByTab.set(tabId, result);
        setBadge(tabId, result.rating);
      }
      sendResponse(result);
    });
    return true; // keep the message channel open for the async response
  }

  if (message.type === "GET_LATEST") {
    sendResponse(latestByTab.get(message.tabId) || null);
  }
});

// A tab loading a new URL invalidates whatever rating we showed for its
// previous page, so the popup/badge don't show a stale result.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    latestByTab.delete(tabId);
    setBadge(tabId, null);
  }
});
