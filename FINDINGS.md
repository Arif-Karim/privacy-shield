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
