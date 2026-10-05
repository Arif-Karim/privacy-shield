# Launch posts (ready to copy)

Post one at a time, a few days apart, and reply to every comment for the
first few hours. Data from the rating pipeline, prompt 2026-10-03.3.

Wording rule: say what a policy *allows* and quote it. Never say a named
company "sells your number" — the ratings are an AI reading of the policy
and can be wrong, and Australian defamation law is strict.

---

## 1. Data post — r/australia, r/AusFinance, Whirlpool (Finance / Telcos)

**Title:** I read the privacy policies of 164 Australian insurance, finance,
telco and retail sites. 38% allow passing your details to other companies
who may contact you.

**Body:**

I kept getting spam calls after getting a few quotes, so I went through
the privacy policies of 164 big Australian websites (with an AI doing the
first read and me checking the rubric), looking for one thing: if you give
them your phone number, can other companies end up contacting you?

Results:

- 🔴 **63 (38%)** say they may sell or pass your details to other companies
  (partners, brokers, "associated businesses") who can contact you themselves
- 🟠 **50 (30%)** don't hand your details over, but use them to send you
  other companies' offers (rewards partners, group brands)
- 🟡 **27 (16%)** only say they'll call or text you themselves
- 🟢 **24 (15%)** keep it to service providers only

Some direct quotes from the policies:

- "This information may also be shared with marketers whose products or
  services we feel may be of interest to you." (dinnerly.com.au)
- "We might also provide your details to other organisations for marketing
  purposes." (newcastlepermanent.com.au)
- "to associated businesses that may want to market products to you"
  (wisr.com.au, stratton.com.au, uno.com.au)
- "When you request a quote through our website, we share your details with
  relevant providers who may contact you…" (energymatters.com.au)

And some that come out well:

- "we are not interested in making money out of trading your Personal
  Information, and we will not sell it…" (hotdoc.com.au)
- "we do not sell personal information for marketing purposes to other
  organisations or allow such companies to do this." (macquarie.com.au)

Biggest takeaways: comparison and quote sites are almost all red, loyalty
programs (Flybuys, Everyday Rewards) share across their partner brands, and
"we don't sell your data" often sits a few paragraphs above "we may disclose
it to our partners for marketing".

I turned this into a free Chrome extension that shows the rating (and the
quote) when a site asks for your number, so you can decide before you hit
submit: https://chromewebstore.google.com/detail/kaojbldoedpalghmmjdjngfgbbojdaai. No account, no tracking. If you think a
rating is wrong, tell me and I'll re-check it.

---

## 2. r/SideProject, r/chrome_extensions

**Title:** I built a Chrome extension that warns you before you give your
phone number to a site that shares it

I was getting 3–4 spam calls a day after getting a few insurance quotes.
Turns out several of those sites' privacy policies say they share your
details with "partners" who may contact you.

Privacy Shield reads the privacy policy of whatever site asks for your
number and shows a colour rating, quoting the exact sentence that decided it:

- red: may sell or pass your number to other companies
- orange: sends you other companies' offers
- yellow: will call or text you itself
- green: keeps it to themselves

Free, no account, no tracking. 250+ big sites already rated. Would love
feedback, especially on ratings you think are wrong: https://chromewebstore.google.com/detail/kaojbldoedpalghmmjdjngfgbbojdaai

Stack, for the curious: MV3 extension, Cloudflare Worker + KV cache, Claude
rating policies against a fixed rubric that I score against hand-labelled
policies before each change.

---

## 3. Show HN

**Title:** Show HN: Privacy Shield – rates a site's privacy policy before you
give it your phone number

**Text:**

When a form asks for your phone number, this Chrome extension finds the
site's privacy policy and rates one thing: will other companies end up
contacting you? Red (shares/sells to companies who can contact you), orange
(markets other companies' offers to you), yellow (calls/texts you itself),
green (service providers only), with the verbatim sentences that decided it.

How it works: the extension only sends the domain and policy URL. A
Cloudflare Worker fetches the policy, hashes the text and rates it with
Claude against a short rubric; results are cached in KV, so most lookups are
instant. Before changing the rubric I run it over a set of hand-labelled
policies. Pre-seeding 300 popular sites is done with a batch pipeline that
renders JS-only policy pages in headless Chromium.

Interesting finding: "we do not sell your personal information" and "we may
share it with partners who may contact you about their products" often
appear in the same policy.

Free to use; new-site checks are funded by optional supporters.
https://chromewebstore.google.com/detail/kaojbldoedpalghmmjdjngfgbbojdaai · https://arif-karim.github.io/privacy-shield/

---

## 4. Product Hunt

Wait until the store listing has ~20 reviews. Tagline: "Know who gets your
phone number before you hit submit."
