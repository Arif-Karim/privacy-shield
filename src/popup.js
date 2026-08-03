const STATUS_TEXT = {
  green: "Looks safe — no strong signal of sharing/selling your data.",
  yellow: "Not sure — couldn't confirm either way.",
  red: "Caution — this site may share or sell your data.",
};

function renderReasons(source, reasons) {
  const list = document.getElementById("reasons");
  list.innerHTML = "";
  for (const reason of reasons || []) {
    const li = document.createElement("li");
    // Heuristic red/green reasons are sentences quoted verbatim from the
    // site's own policy ("we may share...") — attribute them clearly so it
    // doesn't read as Privacy Shield making that statement about itself.
    const isQuote = source === "heuristic" && (reason.signal === "red" || reason.signal === "green");
    li.textContent = isQuote ? `Their privacy policy: "${reason.label}"` : reason.label;
    list.appendChild(li);
  }
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || tab.id == null) return;

  document.getElementById("domain").textContent = new URL(tab.url).hostname;

  const result = await chrome.runtime.sendMessage({ type: "GET_LATEST", tabId: tab.id });

  const dot = document.getElementById("dot");
  const status = document.getElementById("status");

  if (!result) {
    status.textContent = "No email/phone form detected on this page yet.";
    return;
  }

  const { rating, source, reasons } = result;
  dot.classList.add(rating);
  status.textContent = STATUS_TEXT[rating] + (source === "tosdr" ? " (via ToS;DR)" : " (via keyword scan)");
  renderReasons(source, reasons);
}

main();
