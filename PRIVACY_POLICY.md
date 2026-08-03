# Privacy Shield — Privacy Policy

_Last updated: 2026-08-03_

Privacy Shield is a browser extension that warns you before you submit your
email address or phone number to a website that may share or sell your data.
This document explains what the extension does and does not do with your
information.

## What the extension accesses

- **Page content on sites you visit.** The extension reads the current
  page's HTML to detect form fields that look like they collect an email
  address or phone number, and to look for a link to that site's own privacy
  policy. This runs locally in your browser.
- **The current site's domain name.** Used to check whether the site
  already has a public rating from [ToS;DR](https://tosdr.org), a
  crowdsourced privacy/terms-of-service rating project.
- **The site's own privacy policy page.** If ToS;DR has no rating, the
  extension fetches the privacy policy page the site itself links to, and
  scans the text for language indicating the site shares or sells personal
  data with third parties.

## What the extension does NOT do

- It does not collect, store, or transmit the actual information you type
  into forms (your email address, phone number, name, etc.).
- It does not track your browsing history.
- It does not run any analytics or send usage data anywhere.
- It has no backend server of its own — there is currently no
  infrastructure operated by the developer that receives data from the
  extension.

## Third parties contacted

- **`api.tosdr.org`** — queried with only the domain name of the site
  you're currently on (e.g. `example.com`), to retrieve a public rating.
  No personal data is sent.
- **The website you're visiting, and its own privacy policy page** — the
  extension fetches this page's public text directly from the site to scan
  it. No personal data is sent in this request beyond a normal page load.

## Local storage

The extension does not persist a history of sites you've visited or their
ratings. A short-lived, in-memory record of the current tab's result is
kept only so the popup can display it, and this is cleared automatically
whenever the tab navigates to a new page. Nothing is written to disk beyond
your browser's own normal temporary memory for the running extension.

## "Report an issue" feature

If you click "Report an issue" in the popup, the extension prepares a
pre-filled email (page URL, whether a form/privacy link was detected, and
the last rating shown) and opens it in your own email client. **Nothing is
sent automatically** — you see the full contents and choose whether to send
it, exactly like any other email you write.

## Contact

Questions about this policy or the extension can be sent to
arifjubairulkarim@gmail.com.
