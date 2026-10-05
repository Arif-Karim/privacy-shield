# Growth plan

Goal: installs first, money later. Nothing here has been sent or posted yet.

## 1. Anti-scam & privacy YouTubers

Start with small/mid channels (10k–300k subs): they answer email, and a tool
that stops spam calls at the source fits their audience exactly. Big ones
(Kitboga, Scammer Payback, Jim Browning) get hundreds of pitches a week, so
try them too but don't count on them.

Offer: their own supporter link paying them 50% of supporter subscriptions
from their viewers for the first year, plus free supporter keys to give away.
When one says yes, create a dedicated Stripe payment link per creator to
track their sales. Techlore and Jim Browning get a review-only ask (no money).

Channels (status as of 2026-10-05):

| Channel | Contact | Status |
|---|---|---|
| Trilogy Media | info@trilogymedia.com | Gmail draft ready |
| Kitboga | hello@kitbogashow.com | Gmail draft ready |
| Techlore | contact@techlore.tech | Gmail draft ready (framed as "please review", per their protocols) |
| Scammer Payback | tipline@scammerpayback.org (tipline, not business) | Gmail draft ready |
| Pleasant Green | pleasantgreenpictures@gmail.com | Gmail draft ready |
| Jim Browning | form at techsupportscam.com/contact | message written, send via form |
| NBTV (Naomi Brockwell) | nbtv.media contact form (not nbntv.com.au, that's NBN Television) | to find |
| ScammerRevolts | contact@scammerrevolts.com | Gmail draft ready |
| Atomic Shrimp | — | skip: asks not to be contacted about commercial collaborations |

### Outreach email

Subject: A free tool for your viewers who keep getting scam calls

Hi [name],

I'm [your name], a solo developer in Australia. I watch [channel] and I keep
noticing the same question in the comments: "how did they even get my
number?"

Often the answer is a website the viewer gave their number to, whose privacy
policy lets it sell or share it with "partners". So I built Privacy Shield, a
free Chrome extension that reads a site's privacy policy and warns you,
before you type your phone number in, if that site may sell or share it.

- Free, no account, no tracking
- Plain colour rating: red / orange / yellow / green, with the exact quote
  from the policy
- Already covers 250+ of the big insurance, finance, telco and comparison sites

I'd love it if you'd take a look, and if you think it's useful, mention it
to your viewers. I'm happy to give you and your audience free supporter
keys (which unlock checks of new sites) for a giveaway.

Chrome Web Store: [link]
Website: https://arif-karim.github.io/privacy-shield/

Thanks for the work you do,
[your name]

## 2. Launch posts

Post one at a time, a few days apart, and reply to every comment.

- **r/SideProject, r/chrome_extensions, r/InternetIsBeautiful**: self-promo is fine here.
- **r/privacy, r/scams**: strict about self-promotion. Only answer existing
  "how do I stop spam calls" threads helpfully and mention the tool as one option.
- **r/australia / r/AusFinance**: lead with the finding, not the product, e.g.
  "I checked the privacy policies of 250 Aussie insurance and finance sites:
  here's who shares your number" (a data post that links the tool at the end).
- **Whirlpool forums**: same data angle, in the Telcos / Finance forums.
- **Product Hunt**: once there are ~20 reviews on the store.
- **Hacker News (Show HN)**: technical angle: "rating privacy policies with an LLM".

### Reddit post draft (r/SideProject)

Title: I built a Chrome extension that warns you before you give your phone
number to a site that sells it

I was getting 3–4 spam calls a day after getting a few insurance quotes.
Turns out several of those sites' privacy policies say they share your
details with "partners" who may contact you.

Privacy Shield reads the privacy policy of whatever site you're on and shows
a colour rating (red = sells/shares your number, orange = sends you other
companies' offers, yellow = will call you itself, green = keeps it to
themselves), quoting the exact sentence that decided it.

Free, no account, no tracking. Would love feedback on the ratings, especially
any you think are wrong. [link]

## 3. Store listing (free, ongoing)

- Ask early users for reviews: ratings drive store search ranking.
- Keep the name with keywords ("Phone Number & Spam Call Checker").
- Add screenshots of real red ratings on well-known sites.

## 4. Later

- Edge Add-ons store (same build, free listing).
- Firefox port.
