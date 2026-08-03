// Keyword-based fallback scorer, used only when ToS;DR has no rating for a domain.
//
// Sentence-level co-occurrence instead of rigid full-phrase regexes: real privacy
// policies phrase things like "share Personal Information with our trusted third
// party providers" — an exact-phrase match like /share...with third parties/ misses
// that because of the extra words. Instead we split into sentences and check each
// one for an "action" verb (sell/share/disclose/...) plus a "recipient" noun
// (third party/affiliate/marketing/...) anywhere in the same sentence.

const ACTION_RE = /\b(sell|sells|selling|sold|share|shares|shared|sharing|disclose|discloses|disclosing|disclosed|rent|rents|renting|rented|transfer|transfers|transferring|transferred)\b/i;
const RECIPIENT_RE = /\b(third[\s-]?part(y|ies)|affiliate[sd]?|subsidiar(y|ies)|subcontractor[s]?|partner[s]?|marketing|advertis(e|er|ers|ing|ement|ements)|broker[s]?|sponsor[s]?)\b/i;
const NEGATION_RE = /\b(do|does|did)\s+not\b|\bnever\b|\bwill\s+not\b|\bwon'?t\b/i;

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
  const greenReasons = [];

  for (const sentence of splitSentences(text)) {
    const hasAction = ACTION_RE.test(sentence);
    const hasRecipient = RECIPIENT_RE.test(sentence);
    const hasNegation = NEGATION_RE.test(sentence);

    if (hasAction && hasRecipient && !hasNegation) {
      redReasons.push({ signal: "red", label: truncate(sentence) });
    } else if (hasAction && hasNegation && !hasRecipient) {
      // "we do not sell/share your information" style claims, without also
      // naming a recipient in the same breath (those go to redReasons above).
      greenReasons.push({ signal: "green", label: truncate(sentence) });
    }
  }

  let rating;
  let reasons;
  if (redReasons.length > 0) {
    // A concrete disclosure of sharing beats a generic "we don't sell" claim
    // elsewhere in the same policy — the disclosure is what actually happens.
    rating = "red";
    reasons = redReasons.slice(0, 3);
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
