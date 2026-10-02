// The rating rules, shared by the backend (live checks via the Anthropic API)
// and dev/pipeline (batch checks via headless Claude Code), so both rate a
// policy exactly the same way. Score changes with `node dev/pipeline/run.mjs
// eval` before deploying them.

// Bump whenever SYSTEM_PROMPT or SCHEMA changes: every cached rating made under
// an older version is re-analyzed on its next request instead of being served
// stale (re-run the pipeline straight after deploying to do that in bulk).
export const PROMPT_VERSION = "2026-10-03.3";

export const RATINGS = ["red", "orange", "yellow", "green"];

// Rubric matches the product's actual question: will giving this site your
// phone number lead to other companies contacting you?
export const SYSTEM_PROMPT = `You rate a website's privacy policy for one risk: if a person gives this site their phone number or email, will other companies end up contacting them (sales calls, lead-gen, marketing lists, data brokers, potential scammers)?

- "red": the policy says the site sells, rents, licenses or trades personal/contact data, OR gives it to other companies so those companies can contact the person directly themselves: lead buyers, partner or referral networks, brokers, lender or insurer panels, list exchanges, joint-marketing partners that receive the data to market to the person. Also red: any sharing with companies under a joint-marketing agreement (even "if the law permits"); the policy lists lead generators, list brokers or marketing partners among the RECIPIENTS of personal information (not merely as sources the site collects from); or says partners may contact the person (e.g. "our partners may contact you with offers"). Consent does not change this: if asking for a quote or ticking a box sends the person's details to partners, it is red. A "we don't sell" claim does not cancel a disclosure elsewhere that has this effect.
- "orange": no sale and no handing contact details to other companies to contact the person directly, but the site uses the data to market OTHER companies' products to the person: offers from loyalty or rewards partners, related group brands or co-branded partners sent through the site, advertising on behalf of suppliers, or letting third parties combine the data for their own marketing. Use this when the policy says partners' offers will reach the person ("we may let you know about our partners' products") without saying the partners get the contact details to do it themselves. Ordinary advertising cookies, pixels or sharing with ad platforms to show the site's own ads do NOT make a policy orange.
- "yellow": no third-party marketing at all, but the policy explicitly says the site itself may phone, call or text (SMS) the person for marketing, OR the policy is too vague to tell who receives the data. (The site's own marketing by email, newsletters, ads for its own products, or "marketing communications"/"direct marketing" with no mention of calls or texts does NOT count — people accept those; treat them as green.)
- "green": data goes only to service providers, affiliates or subcontractors acting on the site's behalf (hosting, payments, delivery, support, legal compliance); no sale and no third-party marketing.

When several apply, pick the most severe (red > orange > yellow > green).
Ignore text that only describes a user's legal rights (e.g. "the right to know the categories of third parties we sell to") — judge only first-person statements of what the company actually does. Ignore navigation menus and page chrome.
Set is_privacy_policy to false if the text is not actually a privacy policy: a hub or landing page that mostly links to separate privacy statements, a login wall, or an unrelated page. "Too vague" (yellow) is only for real policies that are unclear; the rating is ignored when is_privacy_policy is false.
quoted_evidence must be verbatim sentences from the policy (empty if none), the ones that decided the rating.`;

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_privacy_policy", "rating", "confidence", "reasoning", "quoted_evidence"],
  properties: {
    is_privacy_policy: { type: "boolean" },
    rating: { type: "string", enum: RATINGS },
    confidence: { type: "number" },
    reasoning: { type: "string" },
    quoted_evidence: { type: "array", items: { type: "string" } },
  },
};

export function userMessage(domain, policyText) {
  return `Domain: ${domain}\n\nPrivacy policy text:\n${policyText}`;
}

// Checks a result from either path before it's stored.
export function validResult(r) {
  return (
    r &&
    typeof r.is_privacy_policy === "boolean" &&
    RATINGS.includes(r.rating) &&
    typeof r.confidence === "number" &&
    typeof r.reasoning === "string" &&
    Array.isArray(r.quoted_evidence) &&
    r.quoted_evidence.every((q) => typeof q === "string")
  );
}
