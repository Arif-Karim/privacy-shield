const LOG = "[Privacy Shield:bg]";

// All analysis happens in our backend (Cloudflare Worker): it fetches the
// site's privacy policy itself, rates it with Claude, and caches the rating
// per site until the policy text changes. The extension only says which page
// had a phone field and where that page's privacy policy link points.
const BACKEND_URL = "https://privacy-shield-api.arifjubairulkarim.workers.dev/rate";
// Soft deterrent against casual abuse, not real security — anyone who
// unpacks the extension can read this. Real protection is the backend's
// per-site cache, rate limits and daily call cap.
const EXTENSION_SHARED_KEY = "a33e66b319417b746328055c1fe72a8a15f88fcfc6c5778862ce084cac281507";

// Used only when the backend can't be reached; normally guidance comes from
// the backend so it can be updated without shipping a new extension.
const OFFLINE_GUIDANCE = [
  "Open the privacy policy and search it (Cmd/Ctrl+F) for: sell, partners, third parties, marketing, contact you.",
  "Phrases like \"our network of partners\", \"joint marketing\" or \"may contact you with offers\" mean other companies may call you.",
];

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

// The ratings themselves are cached in the backend; this map just holds the
// current tab's latest result so the popup has something to show when
// opened. It's cleared whenever the tab navigates away.
const latestByTab = new Map();

async function getRating(domain, privacyPolicyUrl) {
  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Extension-Key": EXTENSION_SHARED_KEY },
      body: JSON.stringify({ domain, policyUrl: privacyPolicyUrl }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `backend responded ${res.status}`);
    console.log(LOG, "rating for", domain, "=", data.rating, data.reason || "", "(cached:", data.cached, ")");
    return data;
  } catch (err) {
    console.warn(LOG, "backend unavailable:", err);
    return { rating: "unknown", reason: "backend_unavailable", policyUrl: privacyPolicyUrl, guidance: OFFLINE_GUIDANCE };
  }
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
