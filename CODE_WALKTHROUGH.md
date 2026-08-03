# Code Walkthrough

Read these files in this order — each one hands off to the next.

## 1. `manifest.json` — the table of contents

The only file Chrome reads directly. It tells the browser what every other file
is and when it runs:

```json
"background": { "service_worker": "src/background.js" }   → runs invisibly, always
"content_scripts": [{ "js": ["src/content.js"] }]           → runs inside every page you visit
"action": { "default_popup": "src/popup.html" }              → shown when you click the toolbar icon
```

If you're ever unsure *when* a file runs, this is the file to check.

## 2. `src/content.js` — the "eyes" on the page

Runs inside the actual webpage, in its own isolated JS world (can read/touch
the page's DOM, but can't see the page's own JS variables, and vice versa).

Entry point is at the bottom of the file, outside any function:

```js
scanForPiiInputs();                     // runs once immediately on page load
const observer = new MutationObserver() // keeps watching for inputs added later (SPAs, lazy forms)
```

- `looksLikePiiInput(input)` — is this `<input>` an email/phone field? Checks
  `type="email"/"tel"` first, then falls back to name/id/autocomplete/placeholder
  text matching `/email|phone|mobile|tel/i`.
- `findPrivacyPolicyUrl()` — scans all `<a href>` on the page for link text or
  href matching `/privacy/i`.
- `triggerScan()` — once a PII input is found, sends a `SCAN_REQUEST` message
  (with the domain and privacy policy URL) to the background script via
  `chrome.runtime.sendMessage`, and once a response comes back, calls
  `showBanner()`.
- `showBanner(result)` — builds and injects the on-page colored banner
  (top-right, fixed position, dismissible). Green auto-dismisses after 6s;
  yellow/red stay until closed.

This file never makes network calls itself — it only detects and asks.

## 3. `src/background.js` — the "brain"

The service worker: no DOM, no visible UI, just listens for messages and runs
the actual scoring pipeline. Start at the bottom:

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => { ... })
```

Two message types come in:

- **`SCAN_REQUEST`** (from `content.js`) — calls `getRating(domain, privacyPolicyUrl)`,
  which is the decision pipeline, read top-to-bottom:
  1. `lookupTosdr(domain)` — ask the ToS;DR API (`api.tosdr.org/search/v5`) if
     this domain already has a crowdsourced grade (A–E, mapped to green/yellow/red).
  2. `scanPrivacyPolicy(privacyPolicyUrl)` — if ToS;DR has nothing, fetch the
     privacy policy page ourselves and run the keyword scan (`heuristic.js`).

  Whatever comes back gets stored in `latestByTab` (see below), the toolbar
  badge is set via `setBadge()`, and the result is sent back to `content.js`.

- **`GET_LATEST`** (from `popup.js`) — returns whatever's stored in `latestByTab`
  for the tab the popup asked about.

**No caching, by design (for now).** Every `SCAN_REQUEST` re-fetches and
re-scores from scratch — there's no "have we seen this domain before, skip
the work" logic. `latestByTab` is a plain in-memory `Map` (`tabId → latest
result`) that exists *only* so the popup has something to display when
clicked; it's not a cache in the reuse sense. It's cleared automatically via
the `chrome.tabs.onUpdated` listener at the bottom whenever a tab navigates,
so it can never show a stale rating for the wrong page.

## 4. `src/heuristic.js` — the "is this red or green" logic

Pure functions, no browser APIs — this is why it's easy to unit-test from
plain Node (`node --input-type=module -e "..."`).

- `stripHtml(html)` — strips `<script>`/`<style>` blocks and all remaining
  tags, decodes a few common HTML entities, collapses whitespace. Turns raw
  fetched HTML into plain text.
- `scorePolicyText(text)` — splits the text into sentences, then for each
  sentence checks:
  - `ACTION_RE` — does it contain a data-handling verb (sell/share/disclose/
    rent/transfer)?
  - `RECIPIENT_RE` — does it name a recipient/purpose (third party/affiliate/
    subsidiary/subcontractor/partner/marketing/advertising/broker/sponsor)?
  - `NEGATION_RE` — is it a "do not / never / won't" claim?

  Action + recipient + no negation → **red**, and the matched sentence itself
  becomes the evidence shown in the UI (not a canned label). Action + negation
  + no recipient → **green** claim. No policy signal either way → **yellow**.

  This is sentence-level co-occurrence rather than rigid full-phrase regexes,
  because real policies phrase things like "share Personal Information with
  our trusted third party providers" — an exact-phrase match like
  `/share...with third parties/` misses that due to the extra words in between.

## 5. `src/popup.{html,css,js}` — what you see when you click the icon

- `popup.html` — static structure: a colored dot, the domain, a status line,
  a `<ul>` for reasons.
- `popup.js` — on open: finds the active tab (`chrome.tabs.query`), asks
  background for `GET_LATEST` on that tab's ID, then fills in the dot color
  (`STATUS_TEXT` map), the source (`ToS;DR` vs `keyword scan`), and renders
  each reason as a list item.
- `popup.css` — just styling; nothing behavioral.

## Debugging tips

| Code | Console | How to open it |
|---|---|---|
| `content.js` | The page's own DevTools | Right-click the page → Inspect → **Console** |
| `background.js` | Its own dedicated console | `chrome://extensions` → Privacy Shield card → **"service worker"** link |

Both log under a `[Privacy Shield]` / `[Privacy Shield:bg]` prefix. In the
page's **Sources** tab, content scripts show up under a "Content scripts"
tree in the sidebar — you can set breakpoints directly in `content.js` there.
