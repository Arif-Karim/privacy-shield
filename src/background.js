import { scorePolicyText, stripHtml } from "./heuristic.js";

const LOG = "[Privacy Shield:bg]";

const BADGE_COLORS = {
  green: "#16a34a",
  yellow: "#eab308",
  red: "#dc2626",
};

const TOSDR_GRADE_TO_RATING = {
  A: "green",
  B: "green",
  C: "yellow",
  D: "red",
  E: "red",
};

// No caching for now (by design) — every SCAN_REQUEST re-fetches and re-scores.
// This map just holds the current tab's latest result so the popup has
// something to show when opened; it's cleared whenever the tab navigates.
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

async function scanPrivacyPolicy(privacyPolicyUrl) {
  try {
    console.log(LOG, "fetching privacy policy:", privacyPolicyUrl);
    const res = await fetch(privacyPolicyUrl);
    if (!res.ok) {
      console.warn(LOG, "privacy policy fetch failed with status", res.status);
      return { rating: "yellow", source: "heuristic", reasons: [{ signal: "yellow", label: "couldn't fetch privacy policy page" }] };
    }
    const html = await res.text();
    const text = stripHtml(html);
    console.log(LOG, "extracted", text.length, "chars of policy text; first 200:", text.slice(0, 200));
    const { rating, reasons } = scorePolicyText(text);
    console.log(LOG, "heuristic result:", rating, reasons);
    return { rating, source: "heuristic", reasons };
  } catch (err) {
    console.warn(LOG, "privacy policy scan failed:", err);
    return { rating: "yellow", source: "heuristic", reasons: [{ signal: "yellow", label: "couldn't fetch privacy policy page" }] };
  }
}

async function getRating(domain, privacyPolicyUrl) {
  let result = await lookupTosdr(domain);
  if (!result) {
    result = privacyPolicyUrl
      ? await scanPrivacyPolicy(privacyPolicyUrl)
      : { rating: "yellow", source: "heuristic", reasons: [{ signal: "yellow", label: "no privacy policy link found on page" }] };
  }
  console.log(LOG, "final rating for", domain, "=", result.rating, "(source:", result.source || "tosdr", ")");
  return result;
}

function setBadge(tabId, rating) {
  chrome.action.setBadgeText({ tabId, text: " " });
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS[rating] || "#9ca3af" });
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
    chrome.action.setBadgeText({ tabId, text: "" });
  }
});
