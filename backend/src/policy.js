// Turning a fetched privacy-policy page into the text we analyze and hash.
// Pure functions (no Worker APIs beyond crypto.subtle) so they can be tested
// in Node against real pages.

const CHROME_TAGS = ["script", "style", "noscript", "svg", "template", "iframe", "nav", "header", "footer", "form", "button", "select", "aside"];

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "..." };

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripChrome(html) {
  let out = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of CHROME_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  return out;
}

function toText(html) {
  return decodeEntities(
    html
      // Block-level boundaries become sentence breaks so list items and
      // headings don't run together into one giant "sentence".
      .replace(/<\/?(p|div|li|h[1-6]|tr|td|th|section|article|br|dd|dt)\b[^>]*>/gi, ". ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .replace(/(\.\s*){2,}/g, ". ")
    .trim();
}

// Page HTML -> policy text with navigation, headers, footers, scripts and
// forms removed. Prefers <main>/<article> when it holds the bulk of the text.
export function htmlToPolicyText(html) {
  const cleaned = stripChrome(html);
  const full = toText(cleaned);
  for (const tag of ["main", "article"]) {
    const m = cleaned.match(new RegExp(`<${tag}\\b[\\s\\S]*<\\/${tag}>`, "i"));
    if (m) {
      const inner = toText(m[0]);
      if (inner.length > 1500 && inner.length > full.length * 0.5) return inner;
    }
  }
  return full;
}

export function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((s) => s.length > 20);
}

// Hash of the policy's *set* of sentences, sorted. Pages reorder or repeat
// blocks between loads (A/B tests, CDN variants), which changes a plain text
// hash without the policy itself changing; the sorted set only changes when a
// sentence is actually added, removed or reworded.
export async function policyHash(text) {
  const canonical = [...new Set(splitSentences(text))].sort().join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
