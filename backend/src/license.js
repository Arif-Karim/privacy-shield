// Licence keys for the paid tier (policy-change alerts).
//
// Flow: Stripe Payment Link → checkout → Stripe redirects to
// /license/claim?session_id=… → we confirm the session with Stripe, mint a
// key (once per session) and show it. The extension sends the key with its
// requests; we re-confirm the subscription with Stripe at most every
// RECHECK_MS so cancellations take effect without webhooks.
// Tracked for replacement by Google sign-in: GitHub issue #1.

const RECHECK_MS = 12 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const KEY_RE = /^PS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

async function stripeGet(env, path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${data.error?.message || "unknown error"}`);
  return data;
}

function newKey() {
  // No 0/O/1/I/L so keys survive being read aloud or retyped.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `PS-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

function subscriptionFields(sub) {
  return {
    subscriptionId: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
    status: sub.status,
    // Newer API versions report the period end per subscription item.
    currentPeriodEnd: (sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? 0) * 1000,
  };
}

// Returns {valid, status, currentPeriodEnd} for a key, refreshing from Stripe
// when our copy is older than RECHECK_MS or past its period end.
export async function checkLicense(env, rawKey) {
  const key = String(rawKey || "").trim().toUpperCase();
  if (!KEY_RE.test(key)) return { valid: false, status: "invalid_key" };

  const record = await env.RATINGS_KV.get(`license:${key}`, "json");
  if (!record) return { valid: false, status: "unknown_key" };

  const now = Date.now();
  let current = record;
  const stale = now - record.checkedAt > RECHECK_MS || now > record.currentPeriodEnd;
  if (stale && env.STRIPE_SECRET_KEY && record.subscriptionId) {
    try {
      const sub = await stripeGet(env, `subscriptions/${record.subscriptionId}`);
      current = { ...record, ...subscriptionFields(sub), checkedAt: now };
      await env.RATINGS_KV.put(`license:${key}`, JSON.stringify(current));
    } catch (err) {
      // Stripe unreachable: keep trusting our last copy rather than locking
      // paying users out.
      console.log("license refresh failed", String(err));
    }
  }
  return { valid: ACTIVE_STATUSES.has(current.status), status: current.status, currentPeriodEnd: current.currentPeriodEnd };
}

function page(title, bodyHtml) {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 20px;color:#1f2937}
  h1{font-size:22px} .key{font:600 20px ui-monospace,Menlo,monospace;letter-spacing:.04em;background:#f3f4f6;border:1px solid #d1d5db;border-radius:8px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px}
  button{font:inherit;font-size:14px;padding:6px 12px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer}
  ol{padding-left:20px} .muted{color:#6b7280;font-size:14px}
</style></head><body>${bodyHtml}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// Stripe's success redirect lands here. Idempotent: refreshing the page (or
// Stripe retrying) shows the same key for the same checkout session.
export async function claimPage(env, sessionId) {
  if (!env.STRIPE_SECRET_KEY) return page("Not available yet", "<h1>Subscriptions aren't open yet</h1>");
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId || "")) return page("Invalid link", "<h1>That link isn't valid</h1>");

  let key = await env.RATINGS_KV.get(`claim:${sessionId}`);
  if (!key) {
    let session;
    try {
      session = await stripeGet(env, `checkout/sessions/${sessionId}?expand[]=subscription`);
    } catch (err) {
      console.log("claim lookup failed", String(err));
      return page("Couldn't confirm payment", "<h1>We couldn't confirm that payment</h1><p>If you were charged, reply to your Stripe receipt email and we'll sort it out.</p>");
    }
    const paid = session.status === "complete" && session.subscription && ["paid", "no_payment_required"].includes(session.payment_status);
    if (!paid) return page("Payment not complete", "<h1>This checkout isn't complete yet</h1><p>Finish the payment, then come back to this page.</p>");

    key = newKey();
    const record = { ...subscriptionFields(session.subscription), checkedAt: Date.now(), createdAt: Date.now(), sessionId };
    await env.RATINGS_KV.put(`license:${key}`, JSON.stringify(record));
    await env.RATINGS_KV.put(`claim:${sessionId}`, key);
  }

  return page(
    "Your Privacy Shield licence key",
    `<h1>Thanks — Privacy Shield Plus is ready to switch on</h1>
<p>Your licence key:</p>
<div class="key"><span id="k">${key}</span><button onclick="navigator.clipboard.writeText(document.getElementById('k').textContent);this.textContent='Copied'">Copy</button></div>
<ol>
  <li>Click the Privacy Shield icon in your browser toolbar.</li>
  <li>Paste the key under <b>Privacy Shield Plus</b> and press <b>Activate</b>.</li>
</ol>
<p class="muted">Keep this key somewhere safe — you'll need it if you reinstall the extension. You can manage or cancel your subscription from the link in your Stripe receipt email.</p>`
  );
}
