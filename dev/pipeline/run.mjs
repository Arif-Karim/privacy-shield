// Rating pipeline: rates sites in bulk with headless Claude Code (your Claude
// plan's usage, not the API key) and stores the results in the live database,
// using exactly the backend's rules (backend/src/rubric.js).
//
//   node dev/pipeline/run.mjs discover [--db] [--only a.com,b.com] [--limit N] [--force]
//       fetch privacy policy pages into dev/pipeline/cache/: sites.txt (by
//       finding each homepage's privacy link) plus, with --db, every site
//       already in the database
//   node dev/pipeline/run.mjs rate     [--only …] [--limit N] [--force] [--model sonnet]
//       rate cached policies not yet rated under the current PROMPT_VERSION
//   node dev/pipeline/run.mjs upload   store new ratings in the database (admin key)
//   node dev/pipeline/run.mjs all      [--db] discover + rate + upload
//   node dev/pipeline/run.mjs eval     rate the sites in labels.csv and score them
//   node dev/pipeline/run.mjs report   counts of what's cached and rated
//
// To change the rules: edit backend/src/rubric.js (bump PROMPT_VERSION), run
// `eval` until it scores well, deploy the backend, then `all --db` to re-rate
// everything under the new version.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { htmlToPolicyText, policyHash } from "../../backend/src/policy.js";
import { PROMPT_VERSION, SCHEMA, SYSTEM_PROMPT, userMessage, validResult } from "../../backend/src/rubric.js";

const DIR = import.meta.dirname;
const CACHE = join(DIR, "cache");
const API = "https://privacy-shield-api.arifjubairulkarim.workers.dev";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0 Safari/537.36";
const MIN_POLICY_CHARS = 500; // same as the backend
const MAX_POLICY_CHARS = 200_000;
const FRESH_FETCH_MS = 7 * 24 * 60 * 60 * 1000;

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const LIMIT = Number(option("limit", 0)) || Infinity;
const ONLY = option("only", "") ? new Set(option("only", "").split(",")) : null;
const MODEL = option("model", "sonnet");
const CONCURRENCY = Number(option("concurrency", 3));

mkdirSync(CACHE, { recursive: true });
const metaPath = (id) => join(CACHE, `${id}.json`);
const htmlPath = (id) => join(CACHE, `${id}.html`);
const loadMeta = (id) => (existsSync(metaPath(id)) ? JSON.parse(readFileSync(metaPath(id), "utf8")) : { id });
const saveMeta = (meta) => writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
const allMeta = () => readdirSync(CACHE).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(CACHE, f), "utf8")));

function secret(service) {
  return execFileSync("security", ["find-generic-password", "-a", process.env.USER, "-s", service, "-w"]).toString().trim();
}
const EXTENSION_KEY = readFileSync(resolve(DIR, "../../src/background.js"), "utf8").match(/EXTENSION_SHARED_KEY = "([^"]+)"/)[1];

async function admin(path, body = {}) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Extension-Key": EXTENSION_KEY, "X-Admin-Key": secret("privacy-shield-admin-key") },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return res.json();
}

async function inParallel(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// --- discover ---------------------------------------------------------------

async function get(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    return { ok: res.ok, status: res.status, url: res.url, html: res.ok ? await res.text() : "" };
  } catch (err) {
    return { ok: false, status: String(err.message || err) };
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

async function findPolicyUrl(domain) {
  for (const home of [`https://www.${domain}/`, `https://${domain}/`]) {
    const page = await get(home);
    if (!page.ok) continue;
    const link = findPolicyLink(page.html, page.url);
    if (link) return { policyUrl: link, foundBy: "homepage link" };
    // Homepages built entirely in JavaScript have no links in their HTML.
    for (const path of ["/privacy-policy", "/privacy", "/legal/privacy"]) {
      const guess = await get(new URL(path, page.url).toString());
      if (guess.ok && /privacy/i.test(guess.html)) return { policyUrl: guess.url, foundBy: "common path" };
    }
    return { error: "no privacy link on homepage" };
  }
  return { error: "homepage blocked or unreachable" };
}

// only: a Set of ids to limit to (defaults to --only).
async function discover(only = ONLY) {
  const fromList = readFileSync(join(DIR, "sites.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const fromDb = flag("db") || only ? (await admin("/admin/sites")).sites ?? [] : [];
  const known = new Map(fromDb.filter((s) => s.policyUrl).map((s) => [s.ratedDomain, s.policyUrl]));
  const ids = [...new Set([...fromList, ...(flag("db") ? known.keys() : []), ...(only ?? [])])].filter((id) => !only || only.has(id)).slice(0, LIMIT);
  console.log(`discover: ${ids.length} sites`);
  let done = 0;
  await inParallel(ids, 6, async (id) => {
    const meta = loadMeta(id);
    if (!flag("force") && meta.fetchedAt && Date.now() - meta.fetchedAt < FRESH_FETCH_MS && existsSync(htmlPath(id))) return;
    const found = known.has(id) ? { policyUrl: known.get(id), foundBy: "database" } : await findPolicyUrl(id);
    meta.fetchedAt = Date.now();
    if (found.error) {
      Object.assign(meta, { policyUrl: null, fetchError: found.error });
    } else {
      const page = await get(found.policyUrl);
      Object.assign(meta, { policyUrl: found.policyUrl, foundBy: found.foundBy, fetchError: page.ok ? null : `policy page: ${page.status}` });
      if (page.ok) writeFileSync(htmlPath(id), page.html.slice(0, 3_000_000));
    }
    saveMeta(meta);
    console.log(`${String(++done).padStart(4)} ${id.padEnd(34)} ${meta.fetchError ?? meta.foundBy}`);
  });
}

// --- rate -------------------------------------------------------------------

// Headless Claude Code, stripped down so each call carries only the rules and
// the policy (no MCP servers, settings, tools or CLAUDE.md files).
const scratch = mkdtempSync(join(tmpdir(), "ps-pipeline-"));
writeFileSync(join(scratch, "mcp.json"), JSON.stringify({ mcpServers: {} }));

function claude(input) {
  const argv = [
    "-p", "--model", MODEL, "--effort", "low", "--output-format", "json", "--no-session-persistence",
    "--tools", "", "--strict-mcp-config", "--mcp-config", join(scratch, "mcp.json"), "--setting-sources", "project",
    "--disable-slash-commands", "--system-prompt", SYSTEM_PROMPT, "--json-schema", JSON.stringify(SCHEMA),
  ];
  return new Promise((done, fail) => {
    const child = spawn("claude", argv, { cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), 5 * 60 * 1000);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(out);
        if (data.is_error || !validResult(data.structured_output)) throw new Error(data.result || "no structured output");
        const usage = Object.values(data.modelUsage || {})[0] || {};
        const tokens = (usage.inputTokens || 0) + (usage.cacheCreationInputTokens || 0) + (usage.cacheReadInputTokens || 0) + (usage.outputTokens || 0);
        done({ result: data.structured_output, model: Object.keys(data.modelUsage || {})[0] || MODEL, tokens });
      } catch (e) {
        fail(new Error(`${e.message} ${err.slice(0, 200)}`.trim()));
      }
    });
    child.stdin.end(input);
  });
}

async function policyFor(meta) {
  if (!meta.policyUrl || !existsSync(htmlPath(meta.id))) return null;
  const text = htmlToPolicyText(readFileSync(htmlPath(meta.id), "utf8"));
  if (text.length < MIN_POLICY_CHARS) return { tooShort: true };
  const trimmed = text.slice(0, MAX_POLICY_CHARS);
  return { text: trimmed, hash: await policyHash(trimmed), ratedDomain: new URL(meta.policyUrl).hostname.replace(/^www\./, "") };
}

// ids: a Set of ids to limit to (null = everything in the cache, or --only).
async function rate(ids) {
  const todo = [];
  for (const meta of allMeta()) {
    if ((ids && !ids.has(meta.id)) || (ONLY && !ONLY.has(meta.id))) continue;
    const policy = await policyFor(meta);
    if (!policy) continue;
    if (policy.tooShort) {
      if (meta.rateError !== "too little text (JavaScript-only page?)") saveMeta({ ...meta, rateError: "too little text (JavaScript-only page?)" });
      continue;
    }
    if (!flag("force") && meta.rated?.promptVersion === PROMPT_VERSION && meta.rated.hash === policy.hash) continue;
    todo.push({ meta, policy });
  }
  const batch = todo.slice(0, LIMIT);
  console.log(`rate: ${batch.length} policies with ${MODEL} (prompt ${PROMPT_VERSION})`);
  let tokens = 0;
  let done = 0;
  await inParallel(batch, CONCURRENCY, async ({ meta, policy }) => {
    let line;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await claude(userMessage(policy.ratedDomain, policy.text));
        if (!r.result.is_privacy_policy && !meta.hubUrl && (await followHub(meta))) {
          const next = await policyFor(meta);
          if (next && !next.tooShort) {
            policy = next;
            tokens += r.tokens;
            continue; // rate the page the hub pointed to
          }
        }
        tokens += r.tokens;
        meta.rated = { promptVersion: PROMPT_VERSION, hash: policy.hash, model: r.model, result: r.result, ratedAt: Date.now(), tokens: r.tokens };
        meta.rateError = null;
        line = r.result.is_privacy_policy ? r.result.rating : "not a policy";
        break;
      } catch (err) {
        meta.rateError = String(err.message || err).slice(0, 300);
        line = `error: ${meta.rateError}`;
      }
    }
    saveMeta(meta);
    console.log(`${String(++done).padStart(4)}/${batch.length} ${meta.id.padEnd(34)} ${line}`);
  });
  console.log(`rate: done, ~${Math.round(tokens / 1000)}k tokens of plan usage`);
}

// A hub page that only links to the real policies: pick the main policy link
// on it ("privacy policy/notice/statement"), fetch it and point meta at it.
async function followHub(meta) {
  const html = readFileSync(htmlPath(meta.id), "utf8");
  const candidates = [];
  for (const [, href, inner] of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!/privacy (policy|notice|statement)/i.test(text)) continue;
    try {
      const url = new URL(href.replace(/&amp;/g, "&"), meta.policyUrl);
      if (/^https?:$/.test(url.protocol) && url.toString().split("#")[0] !== meta.policyUrl.split("#")[0]) candidates.push(url.toString());
    } catch {}
  }
  for (const url of candidates.slice(0, 3)) {
    const page = await get(url);
    if (!page.ok || htmlToPolicyText(page.html).length < MIN_POLICY_CHARS) continue;
    writeFileSync(htmlPath(meta.id), page.html.slice(0, 3_000_000));
    Object.assign(meta, { hubUrl: meta.policyUrl, policyUrl: page.url, foundBy: `${meta.foundBy} → followed hub` });
    return true;
  }
  return false;
}

// --- upload -----------------------------------------------------------------

async function upload() {
  const todo = allMeta().filter((m) => m.rated?.promptVersion === PROMPT_VERSION && (m.uploaded?.hash !== m.rated.hash || m.uploaded?.promptVersion !== PROMPT_VERSION) && (!ONLY || ONLY.has(m.id)));
  console.log(`upload: ${todo.length} ratings`);
  let ok = 0;
  for (const meta of todo) {
    const res = await admin("/admin/rating", {
      policyUrl: meta.policyUrl,
      policyHtml: readFileSync(htmlPath(meta.id), "utf8"),
      promptVersion: PROMPT_VERSION,
      model: meta.rated.model,
      result: meta.rated.result,
    });
    if (res.error) {
      console.log(`  ${meta.id}: ${res.error}`);
      continue;
    }
    meta.uploaded = { promptVersion: PROMPT_VERSION, hash: meta.rated.hash, at: Date.now() };
    saveMeta(meta);
    ok++;
  }
  console.log(`upload: ${ok} stored`);
}

// --- eval -------------------------------------------------------------------

async function evaluate() {
  const lines = readFileSync(join(DIR, "labels.csv"), "utf8").trim().split("\n").slice(1);
  const labels = lines.map((l) => l.match(/^([^,]+),([^,]+),(.*)$/)).map(([, domain, expected, why]) => ({ domain, expected, why: why.replace(/^"|"$/g, "") }));
  const ids = new Set(labels.map((l) => l.domain));
  await discover(ids);
  await rate(ids);
  let right = 0;
  const rows = labels.map(({ domain, expected, why }) => {
    const r = loadMeta(domain).rated?.promptVersion === PROMPT_VERSION ? loadMeta(domain).rated.result : null;
    const got = !r ? "—" : r.is_privacy_policy ? r.rating : "not_a_policy";
    if (got === expected) right++;
    return { domain, expected, got, ok: got === expected, why, reasoning: r?.reasoning ?? loadMeta(domain).rateError ?? loadMeta(domain).fetchError ?? "" };
  });
  console.log(`\neval (prompt ${PROMPT_VERSION}, ${MODEL}): ${right}/${rows.length} correct\n`);
  for (const r of rows) console.log(`${r.ok ? "✓" : "✗"} ${r.domain.padEnd(22)} expected ${r.expected.padEnd(12)} got ${r.got}${r.ok ? "" : `\n    label: ${r.why}\n    model: ${r.reasoning.slice(0, 300)}`}`);
  process.exitCode = right === rows.length ? 0 : 1;
}

// --- report -----------------------------------------------------------------

function report() {
  const metas = allMeta();
  const count = (pred) => metas.filter(pred).length;
  const current = metas.filter((m) => m.rated?.promptVersion === PROMPT_VERSION);
  console.log(`prompt ${PROMPT_VERSION}`);
  console.log(`sites in cache: ${metas.length}`);
  console.log(`  no policy page: ${count((m) => !m.policyUrl || m.fetchError)}`);
  console.log(`  rated (current prompt): ${current.length}, uploaded: ${count((m) => m.uploaded?.promptVersion === PROMPT_VERSION && m.uploaded.hash === m.rated?.hash)}`);
  for (const r of ["red", "orange", "yellow", "green"]) console.log(`    ${r}: ${current.filter((m) => m.rated.result.is_privacy_policy && m.rated.result.rating === r).length}`);
  console.log(`    not a policy: ${current.filter((m) => !m.rated.result.is_privacy_policy).length}`);
  console.log(`  rating errors: ${count((m) => m.rateError)}`);
}

const commands = {
  discover,
  rate: () => rate(null),
  upload,
  eval: evaluate,
  report,
  all: async () => {
    await discover();
    await rate(null);
    await upload();
    report();
  },
};
if (!commands[cmd]) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 19).join("\n"));
  process.exit(1);
}
await commands[cmd]();
