// Development only. When the extension is loaded unpacked (store installs
// always have an update_url), reload it as soon as one of its files changes
// on disk, then refresh the tabs Privacy Shield was active in. dev/build.sh
// leaves this file out of the store zip.

const WATCHED = ["manifest.json", "src/background.js", "src/content.js", "src/popup.html", "src/popup.js", "src/popup.css", "src/dev-reload.js"];
const POLL_MS = 1000;

async function snapshot() {
  const texts = await Promise.all(WATCHED.map(async (path) => {
    try {
      return await (await fetch(chrome.runtime.getURL(path), { cache: "no-store" })).text();
    } catch {
      return "";
    }
  }));
  return texts.join("\u0000");
}

async function reloadExtension() {
  // Content scripts in open pages stop working once the extension reloads,
  // so remember which tabs had one and refresh them afterwards.
  const tabIds = Object.keys(await chrome.storage.session.get(null))
    .filter((k) => k.startsWith("tab:"))
    .map((k) => Number(k.slice(4)));
  await chrome.storage.local.set({ devReloadTabs: tabIds });
  chrome.runtime.reload();
}

if (!("update_url" in chrome.runtime.getManifest())) {
  chrome.storage.local.get("devReloadTabs").then(({ devReloadTabs = [] }) => {
    chrome.storage.local.remove("devReloadTabs");
    for (const id of devReloadTabs) chrome.tabs.reload(id).catch(() => {});
  });

  let last = null;
  setInterval(async () => {
    // An extension API call each tick also keeps Chrome from stopping this
    // service worker while idle, so the watcher keeps running.
    chrome.runtime.getPlatformInfo();
    const now = await snapshot();
    if (last !== null && now !== last) {
      console.log("[Privacy Shield:dev] file changed — reloading");
      return reloadExtension();
    }
    last = now;
  }, POLL_MS);
}
