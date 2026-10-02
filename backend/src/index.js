import { htmlToPolicyText, policyHash } from "./policy.js";
import { checkLicense, claimPage } from "./license.js";
import { PROMPT_VERSION, SCHEMA, SYSTEM_PROMPT, userMessage, validResult } from "./rubric.js";

const MODEL = "claude-sonnet-5";
const EFFORT = "low";

const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000; // re-fetch + re-hash a policy at most once a day
const UNREADABLE_RETRY_MS = 24 * 60 * 60 * 1000; // how long to remember "couldn't read this"
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 180; // drop sites nobody has visited in ~6 months
const MAX_POLICY_CHARS = 200_000; // ~50k tokens: far above any real policy, stops pathological pages
const MIN_POLICY_CHARS = 500; // less than this is a JS-rendered shell or an error page
const FETCH_TIMEOUT_MS = 10_000;
const MAX_DAILY_LLM_CALLS = 500; // hard global spend ceiling regardless of traffic/abuse
const MAX_DAILY_LLM_CALLS_PER_IP = 20; // stops one IP from burning the whole day's global budget
// Plans: free users see ratings already in the shared cache. Analysing a
// site nobody has rated yet costs an LLM call, so only Plus does that — and
// the result is cached for everyone. Re-analysing an already-rated site after
// its policy changes (or after a PROMPT_VERSION bump) happens for any user,
// so cached ratings stay current.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Extension-Key",
};

// Shown when we can't give a rating, so the user can check the policy
// themselves. Served from here so it can change without an extension update.
const GUIDANCE = {
  no_policy_link: [
    "On a form asking for your phone number, a missing privacy policy is a warning sign.",
    "Before submitting, look for one elsewhere on the site (usually the page footer) and search it for: sell, partners, third parties, marketing.",
  ],
  not_checked_yet: [
    "Open the privacy policy and search it (Cmd/Ctrl+F) for: sell, partners, third parties, marketing, contact you.",
    "\"We don't sell your data\" doesn't rule out sharing it with partners who will contact you — keep reading.",
  ],
  default: [
    "Open the privacy policy and search it (Cmd/Ctrl+F) for: sell, partners, third parties, marketing, contact you.",
    "Phrases like \"our network of partners\", \"joint marketing\" or \"may contact you with offers\" mean other companies may call you.",
    "\"We don't sell your data\" doesn't rule out sharing it with partners who will contact you — keep reading.",
    "Check the form itself for a pre-ticked box agreeing to be contacted by partners.",
  ],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function unknown(reason, extra = {}) {
  return { rating: "unknown", reason, guidance: GUIDANCE[reason] || GUIDANCE.default, ...extra };
}

// Only public http(s) pages — the backend fetches this URL itself, so reject
// anything that could point it at localhost or a raw IP.
function parsePolicyUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) return null;
  url.hash = "";
  return url;
}

async function fetchPolicyText(url) {
  let res;
  try {
    res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PrivacyShieldBot/1.0; +https://arif-karim.github.io/privacy-shield/)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: `fetch failed: ${err}` };
  }
  if (!res.ok) return { error: `status ${res.status}` };
  return policyTextFromHtml(await res.text());
}

function policyTextFromHtml(rawHtml) {
  const html = rawHtml.slice(0, 3_000_000);
  const text = htmlToPolicyText(html);
  if (text.length < MIN_POLICY_CHARS) return { error: `only ${text.length} chars of text (likely JS-rendered)` };
  return { text: text.slice(0, MAX_POLICY_CHARS) };
}

async function classifyWithClaude(domain, policyText, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage(domain, policyText) }],
      output_config: { effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } },
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (data.stop_reason !== "end_turn") throw new Error(`unexpected stop_reason: ${data.stop_reason}`);
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in Claude response");
  const result = JSON.parse(textBlock.text);
  if (!validResult(result)) throw new Error("Claude returned an invalid result");
  return result;
}

async function getCount(kv, key) {
  const raw = await kv.get(key);
  return raw ? parseInt(raw, 10) : 0;
}

async function incrementCount(kv, key, current) {
  // Not atomic, but good enough as a soft spend ceiling — worst case a
  // handful of concurrent requests overshoot slightly, never wildly.
  await kv.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
}

// What the extension sees: the stored record minus internal fields.
function publicView(record, extra = {}) {
  const { hash, promptVersion, model, previous, ...rest } = record;
  if (rest.rating === "unknown") rest.guidance = GUIDANCE[rest.reason] || GUIDANCE.default;
  return { ...rest, ...extra };
}

// caller: {ip, paid, admin}. adminHtml: the policy page as fetched by our
// seeding script, for sites that block Cloudflare's servers (admin only).
async function rate(env, caller, domain, policyUrlRaw, adminHtml = null) {
  const clientIp = caller.ip;
  if (!policyUrlRaw) return unknown("no_policy_link", { domain });

  const policyUrl = parsePolicyUrl(policyUrlRaw);
  if (!policyUrl) return unknown("unreadable", { domain });

  // Ratings belong to whoever owns the policy, not the page the form sat on:
  // a quote widget embedded from app.vendor.com that links to
  // insurer.com.au/privacy is rated as insurer.com.au.
  const ratedDomain = policyUrl.hostname.toLowerCase().replace(/^www\./, "");
  const key = `site:${ratedDomain}`;
  const now = Date.now();
  const record = await env.RATINGS_KV.get(key, "json");

  const fresh =
    record &&
    record.promptVersion === PROMPT_VERSION &&
    now - record.checkedAt < (record.rating === "unknown" ? UNREADABLE_RETRY_MS : RECHECK_AFTER_MS);
  if (fresh && !(adminHtml && record.rating === "unknown")) return publicView(record, { cached: true });

  // A site nobody has rated yet costs an LLM call, so that's Plus only.
  const isNewSite = !record || record.rating === "unknown";
  if (isNewSite && !caller.paid) {
    if (record) return publicView(record, { cached: true });
    return unknown("not_checked_yet", { ratedDomain, policyUrl: policyUrl.toString(), cached: false });
  }

  // Always read the policy from the site itself. The extension only tells us
  // where it is — accepting policy text from clients would let anyone rewrite
  // the shared rating for any site. (Only our own seeding script, holding the
  // admin key, may hand over a page the site wouldn't serve to Cloudflare.)
  let fetched = await fetchPolicyText(record?.policyUrl && record.rating !== "unknown" ? new URL(record.policyUrl) : policyUrl);
  if (fetched.error && adminHtml) fetched = policyTextFromHtml(adminHtml);
  if (fetched.error) {
    console.log("policy fetch failed", ratedDomain, fetched.error);
    if (record && record.rating !== "unknown") {
      // Keep serving the last good rating; we just couldn't confirm it today.
      await env.RATINGS_KV.put(key, JSON.stringify({ ...record, checkedAt: now }), { expirationTtl: RECORD_TTL_SECONDS });
      return publicView(record, { cached: true });
    }
    const unreadable = { ...unknown("unreadable"), ratedDomain, policyUrl: policyUrl.toString(), checkedAt: now, promptVersion: PROMPT_VERSION };
    await env.RATINGS_KV.put(key, JSON.stringify(unreadable), { expirationTtl: RECORD_TTL_SECONDS });
    return publicView(unreadable, { cached: false });
  }

  const hash = await policyHash(fetched.text);
  if (record && record.hash === hash && record.promptVersion === PROMPT_VERSION) {
    const touched = { ...record, checkedAt: now };
    await env.RATINGS_KV.put(key, JSON.stringify(touched), { expirationTtl: RECORD_TTL_SECONDS });
    return publicView(touched, { cached: true });
  }

  // New site, changed policy, or new prompt version — this costs an LLM call.
  const today = new Date().toISOString().slice(0, 10);
  const globalKey = `usage:${today}`;
  const ipKey = `usage:${today}:ip:${clientIp}`;
  const callsToday = await getCount(env.RATINGS_KV, globalKey);
  const ipCallsToday = await getCount(env.RATINGS_KV, ipKey);
  if (callsToday >= MAX_DAILY_LLM_CALLS || (ipCallsToday >= MAX_DAILY_LLM_CALLS_PER_IP && !caller.admin)) {
    if (record && record.rating !== "unknown") return publicView(record, { cached: true, outdated: true });
    return unknown("busy", { ratedDomain, cached: false });
  }

  const result = await classifyWithClaude(ratedDomain, fetched.text, env.ANTHROPIC_API_KEY);
  await incrementCount(env.RATINGS_KV, globalKey, callsToday);
  await incrementCount(env.RATINGS_KV, ipKey, ipCallsToday);

  const next = await storeAnalysis(env, { ratedDomain, policyUrl: record?.policyUrl ?? policyUrl.toString(), hash, model: MODEL, result });
  return publicView(next, { cached: false });
}

async function storeAnalysis(env, { ratedDomain, policyUrl, hash, model, result }) {
  const now = Date.now();
  const base = { ratedDomain, policyUrl, hash, promptVersion: PROMPT_VERSION, model, analyzedAt: now, checkedAt: now };
  const next = result.is_privacy_policy
    ? { ...base, rating: result.rating, confidence: result.confidence, reasoning: result.reasoning, quoted_evidence: result.quoted_evidence }
    : { ...base, ...unknown("not_a_policy") };
  await env.RATINGS_KV.put(`site:${ratedDomain}`, JSON.stringify(next), { expirationTtl: RECORD_TTL_SECONDS });
  return next;
}

// dev/pipeline: store a rating made by headless Claude Code. The policy page
// comes along so the hash is computed here, the same way as for live checks.
async function adminStoreRating(env, body) {
  const policyUrl = parsePolicyUrl(body.policyUrl);
  if (!policyUrl || typeof body.policyHtml !== "string") return { error: "policyUrl and policyHtml required" };
  if (body.promptVersion !== PROMPT_VERSION) return { error: `rated with prompt ${body.promptVersion}, backend is on ${PROMPT_VERSION}` };
  if (!validResult(body.result)) return { error: "invalid result" };
  const fetched = policyTextFromHtml(body.policyHtml);
  if (fetched.error) return { error: fetched.error };
  const ratedDomain = policyUrl.hostname.toLowerCase().replace(/^www\./, "");
  const model = `claude-code:${String(body.model || "unknown").slice(0, 40)}`;
  return storeAnalysis(env, { ratedDomain, policyUrl: policyUrl.toString(), hash: await policyHash(fetched.text), model, result: body.result });
}

// dev/pipeline: every rated site, so the whole database can be re-rated.
async function adminListSites(env) {
  const sites = [];
  let cursor;
  do {
    const page = await env.RATINGS_KV.list({ prefix: "site:", cursor });
    for (const k of page.keys) sites.push(k.name.slice(5));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const records = await Promise.all(sites.map((d) => env.RATINGS_KV.get(`site:${d}`, "json")));
  return records.filter(Boolean).map(({ ratedDomain, policyUrl, rating, reason, promptVersion, model }) => ({ ratedDomain, policyUrl, rating, reason, promptVersion, model }));
}

// Extensions before v0.4.1 only know red/yellow/green: they show orange as
// red (they don't send ratingLevels).
function forClient(result, body) {
  return result.rating === "orange" && body.ratingLevels !== 4 ? { ...result, rating: "red" } : result;
}

function readDomain(value) {
  const domain = String(value || "").toLowerCase().trim();
  return domain && domain.length <= 253 && /^[a-z0-9.-]+$/.test(domain) ? domain : null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Browser-facing pages/data: no extension key (Stripe redirects here, and
    // the popup reads checkout links before any key exists).
    if (request.method === "GET" && url.pathname === "/license/claim") {
      return claimPage(env, url.searchParams.get("session_id"));
    }
    if (request.method === "GET" && url.pathname === "/config") {
      return jsonResponse({
        checkout: { monthly: env.CHECKOUT_MONTHLY_URL || null, yearly: env.CHECKOUT_YEARLY_URL || null },
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Not found" }, 404);
    }
    if (!["/rate", "/license/validate", "/admin/rating", "/admin/sites"].includes(url.pathname)) {
      return jsonResponse({ error: "Not found" }, 404);
    }

    // Not real auth (a shared key embedded in the extension can be extracted
    // by anyone determined enough) — just raises the bar above "anyone can
    // curl this for free" and stops the most casual abuse.
    if (request.headers.get("X-Extension-Key") !== env.EXTENSION_SHARED_KEY) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    // Our own pipeline (dev/pipeline) pre-rates popular sites: it skips the
    // per-IP limits below, but never the global daily LLM cap.
    const admin = Boolean(env.ADMIN_KEY) && request.headers.get("X-Admin-Key") === env.ADMIN_KEY;

    // Burst protection: no single IP can hammer these endpoints (this also
    // makes guessing licence keys impractical).
    const { success: withinBurstLimit } = admin ? { success: true } : await env.IP_BURST_LIMITER.limit({ key: clientIp });
    if (!withinBurstLimit) {
      return jsonResponse({ error: "Too many requests, slow down." }, 429);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    try {
      if (url.pathname === "/rate") {
        const domain = readDomain(body.domain);
        if (!domain) return jsonResponse({ error: "Missing or invalid domain" }, 400);
        const policyUrl = typeof body.policyUrl === "string" && body.policyUrl.length <= 2048 ? body.policyUrl : null;
        const paid = body.licenseKey ? (await checkLicense(env, body.licenseKey)).valid : false;
        const adminHtml = admin && typeof body.policyHtml === "string" ? body.policyHtml : null;
        const result = await rate(env, { ip: clientIp, paid: paid || admin, admin }, domain, policyUrl, adminHtml);
        return jsonResponse({ ...forClient(result, body), plan: paid ? "plus" : "free" });
      }

      if (url.pathname.startsWith("/admin/")) {
        if (!admin) return jsonResponse({ error: "Unauthorized" }, 401);
        if (url.pathname === "/admin/sites") return jsonResponse({ promptVersion: PROMPT_VERSION, sites: await adminListSites(env) });
        const stored = await adminStoreRating(env, body);
        return jsonResponse(stored, stored.error ? 400 : 200);
      }

      // /license/validate
      return jsonResponse(await checkLicense(env, body.licenseKey));
    } catch (err) {
      console.log(url.pathname, "failed", String(err));
      return jsonResponse({ error: String(err) }, 502);
    }
  },
};
