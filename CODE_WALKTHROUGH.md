# Code Walkthrough

Two halves: the **extension** (runs in the user's browser) and the
**backend** (a Cloudflare Worker that reads privacy policies and caches
ratings). Read them in this order — each one hands off to the next.

```
page with a phone field
  → content.js      notices it, finds the privacy policy link
  → background.js   sends {domain, policyUrl} to the backend
  → backend         fetches the policy itself, rates it (or serves the cached rating)
  → background.js   sets the toolbar icon, stores the result for the popup
  → content.js      shows a banner for red / unknown
  → popup.js        shows the details when the icon is clicked
```

## Extension

### 1. `manifest.json` — the table of contents

The only file Chrome reads directly. It tells the browser what every other file
is and when it runs:

```json
"background": { "service_worker": "src/background.js" }   → runs invisibly, always
"content_scripts": [{ "js": ["src/content.js"] }]           → runs inside every page you visit (all frames)
"action": { "default_popup": "src/popup.html" }              → shown when you click the toolbar icon
"host_permissions": ["https://privacy-shield-api…workers.dev/*"] → the only server the extension talks to
```

If you're ever unsure *when* a file runs, this is the file to check.

### 2. `src/content.js` — the "eyes" on the page

Runs inside the actual webpage (and inside embedded iframes, e.g. third-party
quote widgets), in its own isolated JS world.

Entry point is at the bottom of the file:

```js
scanForPhoneInputs();                   // runs once immediately on page load
const observer = new MutationObserver() // keeps watching for inputs added later (multi-step wizards, SPAs)
```

- `looksLikePhoneInput(input)` — is this `<input>` a phone field? Checks
  `type="tel"` first, then name/id/autocomplete/placeholder/aria-label for
  phone/mobile/tel. **Email-only forms deliberately trigger nothing** — the
  risk this extension targets is your number reaching companies that call you.
- `findPrivacyPolicyUrl()` — the first `<a href>` whose text or href mentions
  privacy.
- `triggerScan()` — once a phone field is found, sends a `SCAN_REQUEST`
  (domain + privacy policy URL) to the background script.
- `showBanner(result)` — only for **red** and **unknown**; green/yellow just
  change the toolbar icon. Built with `textContent` only, never `innerHTML`:
  quoted policy text comes from a third-party site and must not be able to
  inject markup into the page. Auto-dismisses (red 14s, unknown 20s).

### 3. `src/background.js` — the messenger

The service worker. Two messages come in:

- **`SCAN_REQUEST`** (from `content.js`) — `getRating()` POSTs
  `{domain, policyUrl}` to the backend's `/rate`. If the backend can't be
  reached it returns `rating: "unknown"` with offline guidance instead of
  guessing. The result goes into `latestByTab`, the toolbar icon is swapped
  via `setBadge()` (a dot baked into the icon — see the comment there for why
  `setIcon({imageData})` rather than `{path}`), and it's sent back to the page.
- **`GET_LATEST`** (from `popup.js`) — returns `latestByTab` for that tab.

`latestByTab` is an in-memory `Map` (`tabId → result`) only so the popup has
something to show; it's cleared when the tab navigates. Ratings are cached in
the backend, not here.

### 4. `src/popup.{html,css,js}` — what you see when you click the icon

`popup.js` finds the active tab, asks for `GET_LATEST`, and renders: the
colored dot, a plain-English status line (`STATUS_TEXT`), a note (why it's
unknown, or "Based on X's privacy policy" when the form was embedded from
another company), up to three quoted policy sentences (or the guidance list
for unknown), and a link to the full policy. The "Report an issue" button
opens a pre-filled email with diagnostics.

## Backend (`backend/`)

### 5. `backend/src/index.js` — routes and `/rate`

`rate(env, clientIp, domain, policyUrl)` is the whole decision, top to bottom:

1. **No policy link** → `unknown / no_policy_link` (with guidance). No LLM call.
2. **Rated domain** = the policy URL's host (minus `www.`), so an embedded
   widget on `app.vendor.com` linking to `insurer.com.au/privacy` is rated as
   `insurer.com.au`. KV key: `site:<ratedDomain>`.
3. **Fresh cache hit** (checked < 24h ago, same `PROMPT_VERSION`) → return it.
4. Otherwise **fetch the policy from the site itself** (the extension never
   sends policy text — that would let anyone rewrite shared ratings). Blocked
   / JS-only / error page → `unknown / unreadable` (or keep serving the last
   good rating if there is one).
5. **Hash unchanged** → just bump `checkedAt`, return the cached rating.
6. **New site, changed policy, or new prompt version** → check the daily
   global and per-IP LLM caps, call Claude (`claude-sonnet-5`, low effort,
   JSON-schema structured output), store the result. If the model says the
   page isn't really a privacy policy → `unknown / not_a_policy`.

**Bump `PROMPT_VERSION` whenever `SYSTEM_PROMPT` or `SCHEMA` changes** — every
cached rating made under the old version is then re-analyzed on its next
request instead of being served stale.

### 6. `backend/src/policy.js` — page → text → hash

- `htmlToPolicyText(html)` — drops nav/header/footer/scripts/forms, turns
  block elements into sentence breaks, prefers `<main>`/`<article>` when it
  holds most of the text.
- `policyHash(text)` — SHA-256 of the **sorted set of unique sentences**, not
  the raw page or text: pages reorder/repeat blocks between loads (A/B tests,
  CDN variants), which changed a plain hash on 5 of 11 real sites tested.

## Free vs Plus

Cached ratings are free for everyone. Rating a site **nobody has rated yet**
costs an LLM call, so only Plus does it: `background.js` sends the
`licenseKey` (if any) with every `/rate` call, and for a free caller a site
with no rating comes back as `unknown / not_checked_yet` (with upgrade
guidance). The new rating is cached, so free users see it from then on.
Re-rating an already-known site (policy changed, or a `PROMPT_VERSION` bump)
happens for any caller, so cached ratings stay current.

## Paid tier: Privacy Shield Plus

1. **Checkout** — Stripe Payment Links (URLs served by the backend's
   `GET /config`, from the `CHECKOUT_MONTHLY_URL` / `CHECKOUT_YEARLY_URL`
   vars, so they can change without an extension release). Stripe redirects
   to `GET /license/claim?session_id=…` (`backend/src/license.js`), which
   confirms the checkout with Stripe, mints a `PS-XXXX-…` key once per session,
   and shows it.
2. **Ask** — the popup only shows the "Help us check this site" support
   card (with the Payment Links) on a `not_checked_yet` result; otherwise it
   just has a small "Have a supporter key?" link.
3. **Activate** — popup → `SET_LICENSE` → `POST /license/validate`. The
   backend re-confirms the subscription with Stripe at most every 12h
   (`checkLicense`), so cancellations take effect without webhooks.
   On a `not_checked_yet` page the popup then sends `RESCAN`, so the site is
   checked straight away.
4. **Use** — the key goes with every `/rate` call; a valid key lets the
   backend analyse sites with no rating yet.

Licence keys are a stopgap until Google sign-in (GitHub issue #1).

## Building and testing

- `dev/build.sh` builds the store zip (`dist/privacy-shield.zip`) and runs
  `dev/e2e.mjs` against exactly that build: Playwright loads it into a real
  Chromium and checks the banners, cached ratings, a stopped service worker,
  repeated reloads, and the dev auto-reload. GitHub Actions
  (`.github/workflows/test.yml`) runs it on every push. The backend allows 10
  requests a minute per IP, so leave a minute between local runs.
- `src/dev-reload.js` (dev only, left out of the zip): when loaded unpacked,
  the extension reloads itself within a second of a file changing and
  refreshes the tabs it was active in.

## Debugging tips

| Code | Logs | How to open it |
|---|---|---|
| `content.js` | The page's own DevTools | Right-click the page → Inspect → **Console** |
| `background.js` | Its own dedicated console | `chrome://extensions` → Privacy Shield card → **"service worker"** link |
| backend | Worker logs | `cd backend && npx wrangler tail` |

Extension logs are prefixed `[Privacy Shield]` / `[Privacy Shield:bg]`. The
backend logs failed policy fetches (`policy fetch failed <domain> <reason>`).
