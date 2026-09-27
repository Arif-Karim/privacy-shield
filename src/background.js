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

async function api(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Extension-Key": EXTENSION_SHARED_KEY },
    body: JSON.stringify(body),
  });
  return { res, data: await res.json() };
}

// The ratings themselves are cached in the backend; this map just holds the
// current tab's latest result so the popup has something to show when
// opened. It's cleared whenever the tab navigates away.
const latestByTab = new Map();

async function getRating(domain, privacyPolicyUrl) {
  try {
    const { res, data } = await api("/rate", { domain, policyUrl: privacyPolicyUrl });
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

// ---------------------------------------------------------------------------
// Paid tier: policy-change alerts.
//
// Whenever the user types a phone number into a rated form, we remember the
// site and the rating it had at that moment (chrome.storage.local, on this
// device only — never the number itself). With an active licence, the
// backend re-checks those sites twice a day; if a site's rating gets worse
// than what the user agreed to, the next page they open shows an alert
// banner.
//
// storage.local: licenseKey, license {valid,status,currentPeriodEnd},
//   watched {ratedDomain: {rating, enteredAt, alertedRating}},
//   alerts [{ratedDomain, from, to, quote, policyUrl, enteredAt, detectedAt, shown}]

const WATCH_ALARM = "policy-watch";
const WATCH_PERIOD_MINUTES = 12 * 60;
const WATCH_BATCH = 20; // backend's per-request limit
const SEVERITY = { green: 0, yellow: 1, red: 2 };

async function recordPhoneEntry(result) {
  if (!result || !result.ratedDomain || !(result.rating in SEVERITY)) return;
  const { watched = {} } = await chrome.storage.local.get("watched");
  // Re-entering a number resets the baseline: the user has now agreed to the
  // policy as it stands today.
  watched[result.ratedDomain] = { rating: result.rating, enteredAt: Date.now(), alertedRating: null };
  await chrome.storage.local.set({ watched });
  console.log(LOG, "watching", result.ratedDomain, "at rating", result.rating);
}

async function checkWatchedSites() {
  const { licenseKey, watched = {}, alerts = [] } = await chrome.storage.local.get(["licenseKey", "watched", "alerts"]);
  if (!licenseKey) return;
  const domains = Object.keys(watched);
  for (let i = 0; i < domains.length; i += WATCH_BATCH) {
    const { res, data } = await api("/watch", { licenseKey, sites: domains.slice(i, i + WATCH_BATCH) });
    if (res.status === 402) {
      await chrome.storage.local.set({ license: data.license });
      console.log(LOG, "licence no longer active:", data.license && data.license.status);
      return;
    }
    if (!res.ok) throw new Error(data.error || `watch responded ${res.status}`);
    for (const site of data.sites) {
      const entry = watched[site.ratedDomain];
      if (!entry || !(site.rating in SEVERITY)) continue;
      const alreadyKnown = Math.max(SEVERITY[entry.rating], entry.alertedRating ? SEVERITY[entry.alertedRating] : -1);
      if (SEVERITY[site.rating] > alreadyKnown) {
        alerts.push({
          ratedDomain: site.ratedDomain,
          from: entry.rating,
          to: site.rating,
          quote: (site.quoted_evidence && site.quoted_evidence[0]) || site.reasoning || "",
          policyUrl: site.policyUrl,
          enteredAt: entry.enteredAt,
          detectedAt: Date.now(),
          shown: false,
        });
        entry.alertedRating = site.rating;
        console.log(LOG, "ALERT:", site.ratedDomain, entry.rating, "->", site.rating);
      }
    }
  }
  await chrome.storage.local.set({ watched, alerts: alerts.slice(-50), lastWatchCheck: Date.now() });
}

async function ensureWatchAlarm() {
  if (!(await chrome.alarms.get(WATCH_ALARM))) {
    chrome.alarms.create(WATCH_ALARM, { delayInMinutes: 1, periodInMinutes: WATCH_PERIOD_MINUTES });
  }
}
chrome.runtime.onInstalled.addListener(ensureWatchAlarm);
chrome.runtime.onStartup.addListener(ensureWatchAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCH_ALARM) checkWatchedSites().catch((err) => console.warn(LOG, "watch check failed:", err));
});

async function setLicense(key) {
  const { res, data } = await api("/license/validate", { licenseKey: key });
  if (!res.ok) throw new Error(data.error || `validate responded ${res.status}`);
  if (!data.valid) return data;
  await chrome.storage.local.set({ licenseKey: key.trim().toUpperCase(), license: data });
  checkWatchedSites().catch((err) => console.warn(LOG, "watch check failed:", err));
  return data;
}

async function getAccount() {
  const { licenseKey, license, watched = {}, alerts = [] } = await chrome.storage.local.get(["licenseKey", "license", "watched", "alerts"]);
  let checkout = null;
  try {
    checkout = (await (await fetch(`${API_BASE}/config`)).json()).checkout;
  } catch {
    // Offline: the popup just won't show the buy buttons.
  }
  return {
    licensed: Boolean(licenseKey && license && license.valid),
    licenseStatus: license ? license.status : null,
    watchedCount: Object.keys(watched).length,
    recentAlerts: alerts.slice(-3).reverse(),
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
      return respondAsync(
        getRating(message.domain, message.privacyPolicyUrl).then((result) => {
          if (tabId != null) {
            latestByTab.set(tabId, result);
            setBadge(tabId, result.rating);
          }
          return result;
        }),
        sendResponse
      );
    }
    case "GET_LATEST":
      sendResponse(latestByTab.get(message.tabId) || null);
      return false;
    case "PHONE_ENTERED":
      return respondAsync(recordPhoneEntry(message.result).then(() => ({ ok: true })), sendResponse);
    case "GET_PENDING_ALERT":
      return respondAsync(
        (async () => {
          const { alerts = [] } = await chrome.storage.local.get("alerts");
          const alert = alerts.find((a) => !a.shown);
          if (!alert) return null;
          alert.shown = true;
          await chrome.storage.local.set({ alerts });
          return alert;
        })(),
        sendResponse
      );
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

// A tab loading a new URL invalidates whatever rating we showed for its
// previous page, so the popup/badge don't show a stale result.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    latestByTab.delete(tabId);
    setBadge(tabId, null);
  }
});
