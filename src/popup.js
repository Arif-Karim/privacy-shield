const STATUS_TEXT = {
  green: "Looks safe — your details only go to companies working for this site.",
  orange: "Heads up — this site may use your details to send you other companies' offers, though it doesn't say it hands your number to them.",
  yellow: "Some caution — the site may call or text you itself, or its policy is unclear about who gets your data.",
  red: "Warning — this site may sell your number or pass it to companies that will contact you.",
  unknown: "Couldn't check this site's privacy policy automatically. Here's what to look for:",
};

const NOT_CHECKED_TEXT = "We haven't checked this site's privacy policy yet. Until we do, here's what to look for:";

const UNKNOWN_REASON_TEXT = {
  no_policy_link: "This page doesn't link to a privacy policy.",
  unreadable: "The site blocked us from reading its privacy policy.",
  not_a_policy: "The privacy link doesn't lead to an actual privacy policy.",
  busy: "Too many new sites checked today — try again later.",
  backend_unavailable: "Privacy Shield's server couldn't be reached.",
};

const REPORT_EMAIL = "arifjubairulkarim@gmail.com";

let currentTab = null;
let latestResult = null;

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function renderList(items) {
  const list = document.getElementById("reasons");
  list.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  }
}

function getDiagnostics(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "GET_DIAGNOSTICS" }, { frameId: 0 }, (diag) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(diag || { error: "no response from page" });
    });
  });
}

function buildReportBody(tab, diag, result) {
  const lines = [
    "Describe what went wrong (e.g. \"no warning appeared even though the form asks for my phone number\"):",
    "",
    "",
    "--- diagnostics (auto-collected, please leave below) ---",
    `Page URL: ${tab.url}`,
    `Timestamp: ${new Date().toISOString()}`,
    `Extension version: ${chrome.runtime.getManifest().version}`,
    `User agent: ${navigator.userAgent}`,
    "",
    diag.error
      ? `Top-frame diagnostics: unavailable (${diag.error})`
      : [
          `Top-frame scan triggered: ${diag.scanTriggered}`,
          `Top-frame phone input detected right now: ${diag.phoneInputDetectedNow}`,
          `Top-frame privacy policy link (used at scan time): ${diag.privacyPolicyUrlUsed || "none found"}`,
          `Top-frame privacy policy link (right now): ${diag.privacyPolicyUrlNow || "none found"}`,
          `Iframes on page: ${diag.iframeCount}`,
        ].join("\n"),
    "",
    result
      ? `Last rating shown: ${result.rating}${result.reason ? ` (${result.reason})` : ""} for ${result.ratedDomain || "?"}\nReasoning: ${result.reasoning || "-"}`
      : "Last rating shown: none — no scan result recorded for this tab.",
  ];
  return lines.join("\n");
}

async function handleReportClick() {
  const status = document.getElementById("reportStatus");
  const btn = document.getElementById("reportBtn");
  if (!currentTab) return;

  btn.disabled = true;
  status.textContent = "Gathering details…";

  const diag = await getDiagnostics(currentTab.id);
  const domain = new URL(currentTab.url).hostname;
  const subject = `Privacy Shield issue report: ${domain}`;
  const body = buildReportBody(currentTab, diag, latestResult);
  const mailtoUrl = `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  chrome.tabs.create({ url: mailtoUrl });
  status.textContent = "Opened a pre-filled email — please send it to report this.";
  btn.disabled = false;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || tab.id == null) return;
  currentTab = tab;

  const pageDomain = new URL(tab.url).hostname;
  document.getElementById("domain").textContent = pageDomain;

  const result = await chrome.runtime.sendMessage({ type: "GET_LATEST", tabId: tab.id });
  latestResult = result;

  const dot = document.getElementById("dot");
  const status = document.getElementById("status");
  const note = document.getElementById("note");

  dot.className = "dot";
  document.getElementById("reasons").textContent = "";
  if (!result) {
    status.textContent = "No phone number field detected on this page yet.";
  } else {
    dot.classList.add(result.rating);
    status.textContent = result.reason === "not_checked_yet" ? NOT_CHECKED_TEXT : STATUS_TEXT[result.rating] || STATUS_TEXT.unknown;

    const notes = [];
    if (result.rating === "unknown" && UNKNOWN_REASON_TEXT[result.reason]) notes.push(UNKNOWN_REASON_TEXT[result.reason]);
    // Forms embedded from another company (quote widgets etc.) are rated by
    // the privacy policy they link to — say whose policy that was.
    if (result.ratedDomain && result.ratedDomain !== pageDomain.replace(/^www\./, "")) notes.push(`Based on ${result.ratedDomain}'s privacy policy.`);
    if (result.outdated) notes.push("Their policy changed recently and hasn't been re-checked yet.");
    note.textContent = notes.join(" ");

    if (result.rating === "unknown") {
      renderList(result.guidance || []);
    } else if (result.quoted_evidence && result.quoted_evidence.length) {
      // Quotes are in the site's own voice ("we may share..."); attribute them
      // so they don't read as Privacy Shield's statements.
      renderList(result.quoted_evidence.slice(0, 3).map((q) => `Their privacy policy: "${q}"`));
    } else if (result.reasoning) {
      renderList([result.reasoning]);
    }

    const link = document.getElementById("policyLink");
    if (result.policyUrl && isSafeHttpUrl(result.policyUrl)) {
      link.href = result.policyUrl;
      link.hidden = false;
    }
  }

  await renderAccount(result);
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text) n.textContent = text;
  return n;
}

// Supporters (Privacy Shield Plus) get sites nobody has rated yet checked,
// which costs us an LLM call each. So the full ask only appears on such a
// site; otherwise the popup keeps a small link that opens the buy buttons and
// the key box.

function buyButtons(account) {
  const buy = node("div", "buy-row");
  const links = account.checkout || {};
  for (const [label, url] of [["$1.50 / month", links.monthly], ["$12 / year", links.yearly]]) {
    if (!url || !isSafeHttpUrl(url)) continue;
    const b = node("button", null, label);
    b.onclick = () => chrome.tabs.create({ url });
    buy.appendChild(b);
  }
  return buy.childElementCount ? buy : null;
}

async function renderAccount(result) {
  const support = document.getElementById("support");
  const keyArea = document.getElementById("keyArea");
  support.hidden = true;
  support.textContent = "";
  keyArea.textContent = "";
  const account = await chrome.runtime.sendMessage({ type: "GET_ACCOUNT" });
  if (!account || account.error) return;

  if (account.licensed) {
    keyArea.appendChild(node("span", null, "Supporter — thank you! "));
    const remove = node("button", "link-btn", "Remove key");
    remove.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "REMOVE_LICENSE" });
      renderAccount(result);
    };
    keyArea.appendChild(remove);
    return;
  }

  const asking = Boolean(result && result.reason === "not_checked_yet");
  if (asking) {
    support.hidden = false;
    support.appendChild(node("div", "support-title", "Help us check this site"));
    support.appendChild(node("p", null, "Checking a new site costs us money, so it's done for supporters. Support Privacy Shield and we'll check this site now. Every site we check is added to the shared database, free for everyone after that."));
    if (account.licenseStatus && !["invalid_key", "unknown_key"].includes(account.licenseStatus)) {
      support.appendChild(node("p", null, `Your support has ${account.licenseStatus.replace("_", " ")} — renew it to keep checking new sites.`));
    }
    const buy = buyButtons(account);
    if (buy) support.appendChild(buy);
  }

  const toggle = node("button", "link-btn", asking ? "Have a supporter key?" : "Support Privacy Shield or enter your key");
  const form = node("div", "key-panel");
  // The support card above already has the buy buttons on this page.
  const buy = asking ? null : buyButtons(account);
  if (buy) {
    form.appendChild(node("p", null, "Supporters can get any site checked, even ones nobody has checked before. Every check is added to the shared database for everyone."));
    form.appendChild(buy);
    form.appendChild(node("div", "key-label", "Already a supporter? Enter your key:"));
  }
  form.hidden = true;
  toggle.onclick = () => {
    form.hidden = !form.hidden;
    if (!form.hidden) input.focus();
  };
  const row = node("div", "key-row");
  const input = node("input");
  input.placeholder = "PS-XXXX-XXXX-XXXX-XXXX";
  input.setAttribute("aria-label", "Supporter key");
  const activate = node("button", null, "Activate");
  const msg = node("div", "msg");
  activate.onclick = async () => {
    activate.disabled = true;
    msg.textContent = "Checking…";
    const res = await chrome.runtime.sendMessage({ type: "SET_LICENSE", key: input.value });
    activate.disabled = false;
    if (!res || !res.valid) {
      msg.textContent = res && res.error ? "Couldn't reach the server — try again." : "That key isn't active. Check it and try again.";
      return;
    }
    if (asking) {
      // They supported to get this site checked — do it now.
      document.getElementById("status").textContent = "Checking this site…";
      document.getElementById("note").textContent = "";
      document.getElementById("reasons").textContent = "";
      await chrome.runtime.sendMessage({ type: "RESCAN", tabId: currentTab.id });
    }
    main();
  };
  row.append(input, activate);
  form.append(row, msg);
  keyArea.append(toggle, form);
}

document.getElementById("reportBtn").addEventListener("click", handleReportClick);
main();
