const MODEL = "claude-haiku-4-5-20251001";
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days — policies don't change often
const MAX_POLICY_TEXT_CHARS = 15000;
const MAX_DAILY_LLM_CALLS = 500; // hard global spend ceiling regardless of traffic/abuse
const MAX_DAILY_LLM_CALLS_PER_IP = 20; // stops one IP from burning the whole day's global budget

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Extension-Key",
};

const SYSTEM_PROMPT = `You are evaluating a website's privacy policy for one specific risk: will submitting your email/phone number here lead to being contacted (spam calls, marketing calls/texts/emails) or having your data sold to third parties, versus routine/legally-required data handling that carries no solicitation risk.

Rate as:
- "red": the policy discloses selling/renting personal data (any recipient), OR sharing/disclosing data with third parties specifically for marketing/advertising/promotional purposes, joint-marketing arrangements, "lead" networks, or other language indicating the data will be used to contact the person directly. This is the "you'll start getting spam calls" scenario.
- "yellow": the policy discloses sharing with operational vendors, affiliates, subsidiaries, sub-processors, or international transfers for infrastructure/legal-compliance reasons, with NO indication of marketing/solicitation purpose. Also use this if there's genuinely not enough information to judge either way.
- "green": the policy explicitly states data is not sold/shared with third parties, with no contradicting disclosure elsewhere.

Important: ignore boilerplate that merely describes a legal RIGHT the user has (e.g. "the right to know what categories of third parties we disclose to") — that's describing a right, not making a factual claim about actual company behavior. Only count sentences that are actual first-person claims about what the company does.

If no policy text is provided, answer based on your general knowledge of the company/domain, and set based_on to "general_knowledge".`;

const TOOL = {
  name: "rate_privacy_policy",
  description: "Rate a privacy policy for third-party solicitation/data-sale risk",
  input_schema: {
    type: "object",
    properties: {
      rating: { type: "string", enum: ["red", "yellow", "green"] },
      confidence: { type: "number", description: "0 to 1" },
      reasoning: { type: "string", description: "Brief explanation of the rating" },
      quoted_evidence: {
        type: "array",
        items: { type: "string" },
        description: "Verbatim sentences from the policy text that support the rating, if any",
      },
      based_on: { type: "string", enum: ["policy_text", "general_knowledge"] },
    },
    required: ["rating", "confidence", "reasoning", "quoted_evidence", "based_on"],
  },
};

async function classifyWithClaude(domain, policyText, apiKey) {
  const userContent = policyText
    ? `Domain: ${domain}\n\nPrivacy policy text:\n${policyText.slice(0, MAX_POLICY_TEXT_CHARS)}`
    : `Domain: ${domain}\n\nNo privacy policy text was found on this site. Answer based on general knowledge.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "rate_privacy_policy" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const toolUse = data.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("No tool_use block in Claude response");
  return toolUse.input;
}

async function getDailyCallCount(kv, key) {
  const raw = await kv.get(key);
  return raw ? parseInt(raw, 10) : 0;
}

async function incrementDailyCallCount(kv, key, current) {
  // Not atomic, but good enough as a soft spend ceiling — worst case a
  // handful of concurrent requests overshoot slightly, never wildly.
  await kv.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Only POST is supported" }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname !== "/rate") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    // Not real auth (a shared key embedded in the extension can be extracted
    // by anyone determined enough) — just raises the bar above "anyone can
    // curl this for free" and stops the most casual abuse.
    if (request.headers.get("X-Extension-Key") !== env.EXTENSION_SHARED_KEY) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";

    // Burst protection: no single IP can hammer this endpoint, cached or not.
    const { success: withinBurstLimit } = await env.IP_BURST_LIMITER.limit({ key: clientIp });
    if (!withinBurstLimit) {
      return jsonResponse({ error: "Too many requests, slow down." }, 429);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const domain = (body.domain || "").toLowerCase().trim();
    const policyText = typeof body.policyText === "string" ? body.policyText : null;

    if (!domain || domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain)) {
      return jsonResponse({ error: "Missing or invalid domain" }, 400);
    }

    const cacheKey = `rating:${domain}`;
    const cached = await env.RATINGS_KV.get(cacheKey, "json");
    if (cached) {
      return jsonResponse({ ...cached, cached: true });
    }

    const today = new Date().toISOString().slice(0, 10);
    const globalKey = `usage:${today}`;
    const ipKey = `usage:${today}:ip:${clientIp}`;

    const callsToday = await getDailyCallCount(env.RATINGS_KV, globalKey);
    if (callsToday >= MAX_DAILY_LLM_CALLS) {
      return jsonResponse({
        rating: "yellow",
        confidence: 0,
        reasoning: "Daily analysis limit reached — try again later.",
        quoted_evidence: [],
        based_on: "rate_limited",
        cached: false,
      });
    }

    const ipCallsToday = await getDailyCallCount(env.RATINGS_KV, ipKey);
    if (ipCallsToday >= MAX_DAILY_LLM_CALLS_PER_IP) {
      // Distinct from the global limit: this IP specifically has used up its
      // share, but other users' quota (and money) is untouched.
      return jsonResponse({
        rating: "yellow",
        confidence: 0,
        reasoning: "Too many new-site analyses from this network today — try again tomorrow.",
        quoted_evidence: [],
        based_on: "rate_limited",
        cached: false,
      });
    }

    try {
      const result = await classifyWithClaude(domain, policyText, env.ANTHROPIC_API_KEY);
      await incrementDailyCallCount(env.RATINGS_KV, globalKey, callsToday);
      await incrementDailyCallCount(env.RATINGS_KV, ipKey, ipCallsToday);
      await env.RATINGS_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
      return jsonResponse({ ...result, cached: false });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 502);
    }
  },
};
