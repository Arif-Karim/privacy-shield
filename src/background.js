import "./dev-reload.js";

const LOG = "[Privacy Shield:bg]";

// All analysis happens in our backend (Cloudflare Worker): it fetches the
// site's privacy policy itself, rates it with Claude, and caches the rating
// per site until the policy text changes. The extension only says which page
// had a phone field and where that page's privacy policy link points.
const API_BASE = "https://privacy-shield-api.arifjubairulkarim.workers.dev";
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
// icons/icon{16,48,128}-{red,orange,yellow,green}.png), not the runtime badge API —
// chrome.action's text badge forces a minimum pill width that, on a 16px
// icon, ends up covering half the icon like an oversized stamp.
const ICON_PATHS = {
  red: { 16: "icons/icon16-red.png", 48: "icons/icon48-red.png", 128: "icons/icon128-red.png" },
  orange: { 16: "icons/icon16-orange.png", 48: "icons/icon48-orange.png", 128: "icons/icon128-orange.png" },
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
  const entries = await Promise.all(Object.entries({ base: BASE_ICON_PATH, ...ICON_PATHS }).map(async ([name, paths]) => [name, await loadIconVariant(paths)]));
  return Object.fromEntries(entries);
})();

async function api(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Extension-Key": EXTENSION_SHARED_KEY },
    body: JSON.stringify(body),
  });
  return { res, data: await res.json() };
}

// The ratings themselves are cached in the backend; this just holds each
// tab's latest result (and the request behind it, so RESCAN can repeat it)
// for the popup. storage.session, not a Map: the service worker is shut down
// after ~30s idle, e.g. while the user is in checkout. Cleared whenever the
// tab navigates away.
const tabKey = (tabId) => `tab:${tabId}`;
async function getTabState(tabId) {
  return (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)] || null;
}

async function getRating(domain, privacyPolicyUrl) {
  try {
    const { licenseKey } = await chrome.storage.local.get("licenseKey");
    // ratingLevels: this version understands "orange" (older ones get it as red).
    const { res, data } = await api("/rate", { domain, policyUrl: privacyPolicyUrl, licenseKey, ratingLevels: 4 });
    if (!res.ok || data.error) throw new Error(data.error || `backend responded ${res.status}`);
    console.log(LOG, "rating for", domain, "=", data.rating, data.reason || "", "(cached:", data.cached, ")");
    return data;
  } catch (err) {
    console.warn(LOG, "backend unavailable:", err);
    return { rating: "unknown", reason: "backend_unavailable", policyUrl: privacyPolicyUrl, guidance: OFFLINE_GUIDANCE };
  }
}

async function rateForTab(tabId, domain, privacyPolicyUrl) {
  const result = await getRating(domain, privacyPolicyUrl);
  if (tabId != null) {
    await chrome.storage.session.set({ [tabKey(tabId)]: { result, request: { domain, privacyPolicyUrl } } });
    setBadge(tabId, result.rating);
  }
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

// Plus: a licence key lets the backend analyse sites nobody has rated yet.
// storage.local: licenseKey, license {valid,status,currentPeriodEnd}

// Data left behind by the old policy-change alerts and free monthly
// allowance (v0.3.0 and earlier).
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(["watched", "alerts", "lastWatchCheck", "installId", "plan", "quota"]);
});

async function setLicense(key) {
  const { res, data } = await api("/license/validate", { licenseKey: key });
  if (!res.ok) throw new Error(data.error || `validate responded ${res.status}`);
  if (!data.valid) return data;
  await chrome.storage.local.set({ licenseKey: key.trim().toUpperCase(), license: data });
  return data;
}

async function getAccount() {
  const { licenseKey, license } = await chrome.storage.local.get(["licenseKey", "license"]);
  let checkout = null;
  try {
    checkout = (await (await fetch(`${API_BASE}/config`)).json()).checkout;
  } catch {
    // Offline: the popup just won't show the buy buttons.
  }
  return {
    licensed: Boolean(licenseKey && license && license.valid),
    licenseStatus: license ? license.status : null,
    checkout,
  };
}

// Async handlers: return true to keep the channel open for sendResponse.
function respondAsync(promise, sendResponse) {
  promise.then(sendResponse, (err) => sendResponse({ error: String(err.message || err) }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "SCAN_REQUEST": {
      console.log(LOG, "SCAN_REQUEST for", message.domain, "privacyPolicyUrl:", message.privacyPolicyUrl);
      const tabId = sender.tab && sender.tab.id;
      return respondAsync(rateForTab(tabId, message.domain, message.privacyPolicyUrl), sendResponse);
    }
    case "RESCAN": {
      return respondAsync(
        getTabState(message.tabId).then((state) => state && rateForTab(message.tabId, state.request.domain, state.request.privacyPolicyUrl)),
        sendResponse
      );
    }
    case "GET_LATEST":
      return respondAsync(getTabState(message.tabId).then((state) => state && state.result), sendResponse);
    case "SET_LICENSE":
      return respondAsync(setLicense(message.key), sendResponse);
    case "REMOVE_LICENSE":
      return respondAsync(chrome.storage.local.remove(["licenseKey", "license"]).then(() => ({ ok: true })), sendResponse);
    case "GET_ACCOUNT":
      return respondAsync(getAccount(), sendResponse);
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(tabKey(tabId)));

// A tab loading a new URL invalidates whatever rating we showed for its
// previous page, so the popup/badge don't show a stale result.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    chrome.storage.session.remove(tabKey(tabId));
    setBadge(tabId, null);
  }
});
