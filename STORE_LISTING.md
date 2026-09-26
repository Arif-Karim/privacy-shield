# Chrome Web Store listing copy

Drafted for the Developer Dashboard. Character counts noted against current
store limits — re-check limits at submission time in case they've changed.

## Name (max 45 chars)

```
Privacy Shield
```
(14 chars)

## Summary / short description (max 132 chars)

```
Warns you before you submit your email or phone to a site that may share or sell your data.
```
(91 chars)

## Detailed description

```
Privacy Shield checks whether a website is likely to share or sell your
email address or phone number before you submit a form.

WHY THIS EXISTS
Lots of sites — especially quote/lead-gen forms (insurance, solar, home
services) — legally share your contact details with a network of partners
once you submit them. Their privacy policy usually says so, buried in
paragraphs of legal text nobody reads before hitting submit.

WHAT IT DOES
- Watches for email/phone fields as you browse.
- Checks the site's public rating on ToS;DR (a crowdsourced privacy/ToS
  grading project). If there's no rating yet, it sends the site's domain
  and its public privacy-policy text to Privacy Shield's own backend, which
  uses AI (the Claude API) to classify the policy.
- Shows a color-coded result — green (no sharing signal found), yellow
  (couldn't confirm either way), or red (found language suggesting your
  data may be shared or sold) — with the actual matched sentence from
  their policy as evidence, not just a generic warning.

WHAT IT DOESN'T DO
- Doesn't collect, store, or transmit what you actually type into forms.
- Doesn't track your browsing history or record which sites you visit.
- No account, no sign-up, no advertising or third-party analytics.

Found a site where this doesn't work right? Use the "Report an issue"
button in the popup — it opens a pre-filled email with diagnostic details
so it can actually get investigated and fixed.
```

## Category

Suggested: **Productivity** or **Tools** (whichever is closest to current
Chrome Web Store category options at submission time — categories have
changed over the years, so pick the closest match in the dashboard dropdown
rather than relying on this label being exact).

## Privacy practices tab (required for the `<all_urls>` host permission)

Chrome Web Store review requires a plain-language justification for broad
host permissions. Suggested text:

```
Privacy Shield needs to read the content of any site you visit in order to:
(1) detect email/phone input fields as you browse, and (2) fetch that
site's own publicly-posted privacy policy page to evaluate its data-sharing
language. Because the tool must work on whichever site you choose to fill
out a form on — which can't be known in advance — it requests access to all
sites rather than a fixed list.

When a site has no existing ToS;DR rating, the site's domain name and the
text of its public privacy policy are sent to the extension's own backend
service (a Cloudflare Worker), which forwards them to the Claude API
(Anthropic) to classify the policy, and caches the resulting rating by
domain. The extension does NOT collect, transmit, or store your browsing
history or the personal data you type into forms — only the public
privacy-policy text and the domain name are sent, solely to rate that site.
```

Data-use disclosures to select on the dashboard's data-collection form:
- "Website content" — IS handled/transmitted (the public privacy-policy
  text is sent to the backend / Claude for analysis). Disclose it.
- Do NOT check personally identifiable information, financial info,
  authentication info, personal communications, location, browsing history,
  or user activity — none of those are collected.

Privacy policy URL: https://arif-karim.github.io/privacy-shield/

## Screenshots

Store requires at least one screenshot, 1280x800 or 640x400 PNG/JPEG.
A promotional mockup has been generated at `dist/screenshot-1.png`
(see below) — swap in a real one from actual usage once you're testing
live if you'd rather show the real product instead of a mockup.
