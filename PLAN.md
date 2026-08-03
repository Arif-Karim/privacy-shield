# Privacy Shield — Browser Extension Plan

## Problem
Sites collect email/phone in forms and some sell/share that data with third parties
(lead-gen/marketing). Users can't tell which is which before submitting. Concrete case:
lead-gen/quote-comparison sites (e.g. solar quote forms) usually *disclose* in their
privacy policy that they share your info with a network of partner providers — that's
the whole business model, not a leak. Surfacing that disclosure before submit is the
core value.

## Trigger
Active trigger only (for now, no passive always-on badge):
- Content script watches the page for forms/inputs that look like they collect PII
  (`input[type=email]`, `input[type=tel]`, name/id/autocomplete attrs matching
  email/phone/tel patterns).
- On detection, kick off a rating lookup for the current domain and show a
  green/yellow/red indicator near the form (or on the extension toolbar icon).

## Rating pipeline (in order, first hit wins)

1. **ToS;DR lookup** — check if the domain already has a crowdsourced grade.
   - Verified working endpoint: `GET https://api.tosdr.org/search/v5/?query={domain}`
     → `{ "services": [{ "id", "name", "urls": [...], "rating": "A".."E", "slug" }] }`
   - Map ToS;DR grade → our traffic light:
     - A/B → green
     - C → yellow
     - D/E → red
   - Docs are informal/alpha (developers.tosdr.org); re-verify exact endpoint/version
     at implementation time, and handle "not found" gracefully.

2. **Keyword/heuristic fallback** (if ToS;DR has no rating for the domain) — free,
   runs client-side, no backend needed:
   - Locate the privacy policy (look for a link with text matching
     `/privacy( policy)?/i` in the page footer/nav, or common paths like `/privacy`,
     `/privacy-policy`).
   - Fetch and strip the page to plain text.
   - Scan for phrase categories, e.g.:
     - Red signals: "sell your information", "share ... with third parties",
       "marketing partners", "our network of partners", "data brokers"
     - Green signals: "we do not sell", "we do not share your personal information"
     - Yellow: policy not found, too short/vague, or mixed signals
   - Simple scoring: count/weight hits per category → green/yellow/red.
   - Known limitation: crude, will have false positives/negatives (e.g. "we do not
     sell" clauses that still carve out "service providers").

## Later phases (not now)
- **LLM-assisted scoring**: instead of raw keyword counting, pull each keyword hit
  plus surrounding sentence/paragraph context and send that (not the whole policy)
  to an LLM to classify intent (discloses sharing vs. explicitly rules it out).
  Keeps cost down by only sending short snippets, not full policies.
- **Caching**: cache ratings per-domain (heuristic + LLM results) so repeat visits
  and other users benefit without re-scanning. Needs a small backend/shared store
  once we get here — skip for MVP, each install just scans locally.

## Open items to revisit later
- Where heuristic/LLM scan results get cached (local storage first, shared backend later).
- Exact ToS;DR endpoint/version to lock in at implementation time.
- How to surface the yellow/red reasoning to the user (tooltip with the matched
  phrase/sentence, not just a color).
