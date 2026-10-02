// Pre-rates popular sites so free users see real ratings from day one.
// For each domain in dev/seed-sites.txt: fetch the homepage, find its privacy
// policy link (same rule as src/content.js), then ask the backend to rate it.
// Uses the admin key (macOS keychain: privacy-shield-admin-key), which skips
// the per-IP limits but not the backend's global daily cap of LLM calls.
// Already-rated sites come back from the cache at no cost. The policy page is
// also fetched here and sent along: the backend only uses it if the site
// blocks Cloudflare's servers (many big insurers and banks do).
// Run: node dev/seed.mjs [N]   → writes dev/seed-results.csv (N: first N only)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const API = "https://privacy-shield-api.arifjubairulkarim.workers.dev/rate";
const DIR = import.meta.dirname;
const EXTENSION_KEY = readFileSync(resolve(DIR, "../src/background.js"), "utf8").match(/EXTENSION_SHARED_KEY = "([^"]+)"/)[1];
const ADMIN_KEY = execFileSync("security", ["find-generic-password", "-a", process.env.USER, "-s", "privacy-shield-admin-key", "-w"]).toString().trim();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36";
const CONCURRENCY = 4;

const domains = [...new Set(readFileSync(resolve(DIR, "seed-sites.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")))].slice(0, Number(process.argv[2]) || undefined);

async function get(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
    return { ok: res.ok, url: res.url, html: res.ok ? await res.text() : "" };
  } catch {
    return { ok: false };
  }
}

// Mirrors findPrivacyPolicyUrl() in src/content.js, preferring links that
// say "policy" when there are several.
function findPolicyLink(html, base) {
  const links = [];
  for (const [, href, inner] of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!/privacy( policy)?/i.test(text) && !/privacy-?policy/i.test(href)) continue;
    try {
      const url = new URL(href.replace(/&amp;/g, "&"), base);
      if (url.protocol === "https:" || url.protocol === "http:") links.push({ url: url.toString(), score: /policy/i.test(text + href) ? 1 : 0 });
    } catch {}
  }
  links.sort((a, b) => b.score - a.score);
  return links[0]?.url ?? null;
}

async function policyFor(domain) {
  for (const home of [`https://www.${domain}/`, `https://${domain}/`]) {
    const page = await get(home);
    if (!page.ok) continue;
    const link = findPolicyLink(page.html, page.url);
    if (link) return { host: new URL(page.url).hostname, policyUrl: link, how: "homepage link" };
    // Homepages built entirely in JavaScript have no links in their HTML;
    // try the usual policy paths.
    for (const path of ["/privacy-policy", "/privacy", "/legal/privacy"]) {
      const guess = await get(new URL(path, page.url).toString());
      if (guess.ok && /privacy/i.test(guess.html)) return { host: new URL(page.url).hostname, policyUrl: guess.url, how: "common path" };
    }
    return { host: new URL(page.url).hostname, policyUrl: null, how: "no link found" };
  }
  return { host: domain, policyUrl: null, how: "homepage unreachable" };
}

async function rate(domain, policyUrl) {
  const page = await get(policyUrl);
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Extension-Key": EXTENSION_KEY, "X-Admin-Key": ADMIN_KEY },
    body: JSON.stringify({ domain, policyUrl, policyHtml: page.ok ? page.html.slice(0, 3_000_000) : undefined }),
    signal: AbortSignal.timeout(90000),
  });
  return res.json();
}

const rows = [];
let next = 0;
async function worker() {
  while (next < domains.length) {
    const domain = domains[next++];
    const found = await policyFor(domain);
    let result = { rating: "skipped", reason: found.how };
    if (found.policyUrl) {
      try {
        result = await rate(found.host, found.policyUrl);
      } catch (err) {
        result = { rating: "error", reason: String(err.message || err) };
      }
    }
    rows.push({ domain, policyUrl: found.policyUrl ?? "", how: found.how, rating: result.rating, reason: result.reason ?? "", cached: result.cached ?? "", ratedDomain: result.ratedDomain ?? "" });
    console.log(`${String(rows.length).padStart(3)}/${domains.length} ${domain.padEnd(32)} ${result.rating}${result.reason ? ` (${result.reason})` : ""}${result.cached ? " [cached]" : ""}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const csv = (v) => `"${String(v).replace(/"/g, '""')}"`;
rows.sort((a, b) => a.domain.localeCompare(b.domain));
writeFileSync(resolve(DIR, "seed-results.csv"), ["domain,policy_url,found_by,rating,reason,cached,rated_domain", ...rows.map((r) => [r.domain, r.policyUrl, r.how, r.rating, r.reason, r.cached, r.ratedDomain].map(csv).join(","))].join("\n") + "\n");

const count = (pred) => rows.filter(pred).length;
console.log(`\nDone: ${rows.length} sites`);
for (const r of ["green", "yellow", "red", "unknown", "skipped", "error"]) console.log(`  ${r}: ${count((x) => x.rating === r)}`);
console.log(`  newly analysed (LLM calls): ~${count((x) => x.cached === false && ["green", "yellow", "red"].includes(x.rating)) + count((x) => x.reason === "not_a_policy" && x.cached === false)}`);
