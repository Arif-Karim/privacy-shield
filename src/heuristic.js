// Keyword-based fallback scorer, used only when ToS;DR has no rating for a domain.
//
// Sentence-level co-occurrence instead of rigid full-phrase regexes: real privacy
// policies phrase things like "share Personal Information with our trusted third
// party providers" — an exact-phrase match like /share...with third parties/ misses
// that because of the extra words. Instead we split into sentences and check each
// one for an "action" verb (sell/share/disclose/...) plus a "recipient" noun
// (third party/affiliate/marketing/...) anywhere in the same sentence.

// Selling/renting is unambiguous monetization regardless of who the buyer is.
const SELL_ACTION_RE = /\b(sell|sells|selling|sold|rent|rents|renting|rented)\b/i;
const ACTION_RE = /\b(sell|sells|selling|sold|share|shares|shared|sharing|disclose|discloses|disclosing|disclosed|rent|rents|renting|rented|transfer|transfers|transferring|transferred)\b/i;

// Recipients whose whole point is contacting/soliciting you directly — the
// "your phone starts ringing" scenario that actually motivated this project
// (lead-gen "network of partners", brokers, joint-marketing arrangements).
const SOLICITING_RECIPIENT_RE = /\b(third[\s-]?part(y|ies)|broker[s]?|sponsor[s]?|lead\s*buyer[s]?|marketing[\s-]?partner[s]?|network\s+(of\s+)?partners?|joint[\s-]?marketing)\b/i;

// Recipients that are typically just operational/internal vendors —
// routine business sharing, not solicitation of you as a lead.
const OPERATIONAL_RECIPIENT_RE = /\b(affiliate[sd]?|subsidiar(y|ies)|subcontractor[s]?|service\s*provider[s]?|vendor[s]?|partner[s]?|marketing|advertis(e|er|ers|ing|ement|ements))\b/i;

const NEGATION_RE = /\b(do|does|did)\s+not\b|\bnever\b|\bwill\s+not\b|\bwon'?t\b/i;
// Legal pages are full of section headings like "Disclosure Regarding
// 'Sharing' for Cross-Context Behavioral Advertising under the CCPA" — these
// mention the same action/recipient words as a real disclosure but aren't
// one; they're a title introducing a topic, not a first-person claim about
// what the company actually does. Requiring "we/us/our" filters those out.
const FIRST_PERSON_RE = /\b(we|us|our)\b/i;
// Boilerplate like "we encourage you to review the privacy policies of any
// third party you choose to visit" mentions "we"/"third party"/"disclose"
// but describes what the USER might do on someone else's site, not what this
// company does with the user's data — exclude it so it doesn't falsely read
// as a third-party disclosure.
const ADVISORY_RE = /\bwe\s+(encourage|recommend|suggest|advise)\s+you\b/i;

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && s.length < 400);
}

function truncate(s, max = 180) {
  return s.length > max ? `${s.slice(0, max).trim()}…` : s;
}

export function scorePolicyText(text) {
  if (!text || text.trim().length < 200) {
    return { rating: "yellow", reasons: [{ signal: "yellow", label: "couldn't find enough privacy policy text to evaluate" }] };
  }

  const redReasons = [];
  const amberReasons = []; // rendered as "yellow" rating — operational sharing, not solicitation
  const greenReasons = [];

  for (const sentence of splitSentences(text)) {
    if (ADVISORY_RE.test(sentence)) continue;

    const hasAction = ACTION_RE.test(sentence);
    const hasNegation = NEGATION_RE.test(sentence);
    const isFirstPersonClaim = FIRST_PERSON_RE.test(sentence);
    if (!isFirstPersonClaim) continue;

    if (hasAction && hasNegation) {
      // "we do not sell/share your information [for purpose X]" — still a
      // clear denial even if it names what it's denying (e.g. CCPA-style
      // "we do not share for cross-context behavioral advertising").
      greenReasons.push({ signal: "green", label: truncate(sentence) });
      continue;
    }
    if (hasNegation) continue;

    const hasSellAction = SELL_ACTION_RE.test(sentence);
    const hasSolicitingRecipient = SOLICITING_RECIPIENT_RE.test(sentence);
    const hasOperationalRecipient = OPERATIONAL_RECIPIENT_RE.test(sentence);

    if (hasSellAction || (hasAction && hasSolicitingRecipient)) {
      redReasons.push({ signal: "red", label: truncate(sentence) });
    } else if (hasAction && hasOperationalRecipient) {
      amberReasons.push({ signal: "amber", label: truncate(sentence) });
    }
  }

  let rating;
  let reasons;
  if (redReasons.length > 0) {
    // A concrete disclosure of sharing/selling to a soliciting third party
    // beats anything else found elsewhere in the same policy.
    rating = "red";
    reasons = redReasons.slice(0, 3);
  } else if (amberReasons.length > 0) {
    // Real sharing, but with operational vendors/affiliates rather than
    // parties who'll contact you directly — worth surfacing, not worth
    // interrupting for.
    rating = "yellow";
    reasons = amberReasons.slice(0, 3);
  } else if (greenReasons.length > 0) {
    rating = "green";
    reasons = greenReasons.slice(0, 2);
  } else {
    rating = "yellow";
    reasons = [{ signal: "yellow", label: "no clear data-sharing language found either way" }];
  }

  return { rating, reasons };
}

export function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
