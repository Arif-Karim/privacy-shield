# Findings

Real-site validation results for the extension. Each entry is a site we tested
against, what the extension showed, and why it matters.

## autrabatteries.com — 2026-08-03

**Page:** `autrabatteries.com/contact` ("Get A Free Quote" form — full name, phone, email, state)
**Result:** 🔴 Red — "this site may share or sell your data"
**Evidence shown:** *"In addition to the different uses listed above, we may transfer or disclose Personal Information to our subsidiaries, affiliated companies and subcontractors."*

**Why this matters:** This is the exact scenario that motivated the whole project —
my cousin got flooded with solar sales calls after submitting a quote form, and
suspected his info was sold to a lead-gen network. Autra Batteries' own privacy
policy confirms that pattern directly: elsewhere it also states *"we may share
Personal Information with our trusted third party providers... for... marketing
offers and promotional materials"* — i.e. filling out this "free quote" form
means your info can legally go to marketing partners, not just Autra. The tool
caught this on the first real-world test against the kind of site the project
was built for.

**Bug this surfaced along the way (now fixed):** the first version of the
keyword heuristic used rigid full-phrase regexes (e.g. requiring the literal
text `share...with third parties`) and missed this because the real sentence
has extra words in between (`"...with our trusted third party providers"`).
Rewritten to check for an action word (sell/share/disclose/...) and a
recipient word (third party/affiliate/marketing/...) anywhere in the same
sentence instead — see `heuristic.js` and the "sentence-level co-occurrence"
note in `CODE_WALKTHROUGH.md`.

## najmaa.com.au — 2026-08-03

**Page:** `najmaa.com.au/quote-car/`, step 4 of 6 ("Driver(s) Details" → "Contact details" — email + mobile)
**Result at time of report:** No banner, no badge — total silence despite a live email/mobile form.
**Root cause:** this page's entire quote wizard is a third-party widget embedded via a genuine
cross-origin `<iframe src="https://app.ubind.io/...">` (uBind, an insurance quoting platform).
Confirmed by inspecting the live DOM: the top-level document has **zero** `<input>` elements;
all 201 form fields (including the visible email/mobile inputs once the user reaches step 4)
live inside that iframe. Our content script's manifest entry didn't set `all_frames`, so Chrome
only ever injected `content.js` into the top frame — it had no way to see the form at all, no
matter how good the detection heuristic was.

**Fix:** added `"all_frames": true` to the `content_scripts` entry in `manifest.json`, so the
script now runs inside every frame (including cross-origin ones) on the page. Bonus finding:
the iframe itself contains a working "Privacy Policy" link back to
`https://www.najmaa.com.au/privacy-policy/`, so once injection works the existing
find-link → fetch → heuristic-scan pipeline should work unmodified.

**Why this matters:** third-party embedded quote/checkout widgets (uBind, and similar
"quote-and-bind" platforms) are extremely common on exactly the kind of lead-gen-adjacent
sites this tool targets (insurance, finance quote forms). Any site using one would have
silently defeated the extension until this fix. Worth watching for more iframe-based forms
as we test more sites.
