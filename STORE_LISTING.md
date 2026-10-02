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
Warns you before you give your phone number to a site that may sell it or pass it to companies that will call you.
```
(113 chars)

## Detailed description

```
Privacy Shield warns you before you type your phone number into a website
that may sell it, or pass it to other companies who will call and text you.

WHY THIS EXISTS
Lots of sites — especially quote/lead-gen forms (insurance, solar, loans,
home services) — pass your phone number to a network of "partners" the
moment you hit submit. Their privacy policy usually says so, buried in
paragraphs of legal text nobody reads. That's how a single quote request
turns into weeks of sales calls — and how numbers end up on lists that
scammers buy.

WHAT IT DOES
- Notices when a form asks for your phone number.
- Reads that site's own privacy policy with AI (the Claude API) and tells
  you, in plain English, who your number may end up with:
  red — the site may sell it or share it with companies that will contact you
  yellow — the site may call or text you itself, or the policy is unclear
  green — your details only go to companies working for the site
- Shows the actual sentence from their policy as evidence, with a link to
  read the whole thing.
- If a site's policy can't be read, it tells you so and shows what to look
  for yourself instead of guessing.
- Free: ratings for every site that's already been checked.
- Privacy Shield Plus ($1.50/month or $12/year): also checks sites no one
  has checked yet, and shares those ratings with everyone.

WHAT IT DOESN'T DO
- Never reads, stores or sends what you type into forms.
- Doesn't track your browsing history. Only a site's domain and privacy
  policy link are sent, and only when a phone-number field appears.
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

## Privacy practices tab

Permissions requested: `activeTab`, `storage`, host permission for
the Privacy Shield backend only, and a content script on all sites.

**Host permission / content script justification:**

```
Privacy Shield's content script runs on every site so it can notice when a
form asks for a phone number — the tool has to work on whichever site the
user fills in a form, which can't be known in advance. The script only
reads the page locally to find phone-number fields and the page's privacy
policy link. When one is found, the extension sends the page's domain name
and the privacy policy link to our own backend (the only host permission
requested), which downloads that public policy itself and rates it with the
Claude API. Nothing the user types into forms is read or sent.
```

**activeTab justification:**

```
Lets the popup show the rating for the tab the user is looking at when they
click the toolbar icon.
```

**storage justification:**

```
Stores the user's Privacy Shield Plus licence key on their device, if they
have one.
```

**Remote code justification:**

```
The extension does not download or execute any remote code. It only
receives JSON ratings from its own backend.
```

**Single purpose description:**

```
Privacy Shield warns users before they give their phone number to a website
whose privacy policy says it may sell the number or pass it to other
companies that will contact them.
```

Data-use disclosures to select on the dashboard's data-collection form:
- **"Web history"** — declare it: the domain of a page with a phone-number
  field is sent to the backend (to rate that site). Being explicit here is
  safer in review than under-declaring.
- **"Website content"** — declare it: the page's privacy policy link is sent.
- **"Authentication information"** — declare it if the dashboard counts a
  subscription licence key as such (it's sent to our backend to check the
  subscription is active).
- Do NOT check personally identifiable information, financial info,
  authentication info, personal communications, location, or user
  activity — none of those are collected.

Privacy policy URL: https://arif-karim.github.io/privacy-shield/privacy/

Website / homepage URL: https://arif-karim.github.io/privacy-shield/

Terms of service URL: https://arif-karim.github.io/privacy-shield/terms/

## Screenshots

Store requires at least one screenshot, 1280x800 or 640x400 PNG/JPEG.
A product screenshot (sample quote form with the real banner and popup) is at `store-assets/screenshot-1280x800.png`
(see below) — swap in a real one from actual usage once you're testing
live if you'd rather show the real product instead of a mockup.
