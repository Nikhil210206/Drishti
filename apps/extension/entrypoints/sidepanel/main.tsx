import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@drishti/ui";
import "@drishti/ui/styles.css";
import { localTransport } from "../../lib/panel-session";
import { loadSettings, ready, type Settings } from "../../lib/settings";

/**
 * Chrome never shows the mic prompt inside a side panel (spike 1): the first grant happens in an
 * extension tab. Open it once per panel; it stays open until the user has allowed the mic.
 */
let grantTabOpened = false;
function openMicGrant(e: unknown) {
  if ((e as Error)?.name !== "NotAllowedError" || grantTabOpened) return;
  grantTabOpened = true;
  void chrome.tabs.create({ url: chrome.runtime.getURL("/permission.html") });
}

/** Tell the grant tab (if open) that the mic works here now, so it can close. */
function micReady() {
  grantTabOpened = false;
  void chrome.runtime.sendMessage({ type: "drishti-mic-ok" }).catch(() => {});
}

/** Not connected, or no agreement to the current privacy summary yet: finish the welcome flow first. */
function FinishSetup() {
  return (
    <main style={{ padding: 16, fontSize: 18 }}>
      <h1>Welcome to Drishti</h1>
      <p>Drishti needs a minute of setup: your language, connecting, and your microphone.</p>
      <button
        autoFocus
        style={{ fontSize: 18, padding: "10px 16px" }}
        onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("/welcome.html") })}
      >
        Set up Drishti
      </button>
    </main>
  );
}

function Panel() {
  const [settings, setSettings] = useState<Settings | undefined>();
  useEffect(() => {
    void loadSettings().then(setSettings);
    // Setup finishing in the welcome tab (or "delete my details") changes settings: follow along.
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      const next = changes.settings?.newValue as Settings | undefined;
      if (next) setSettings((cur) => (cur && ready(cur) === ready(next) && cur.token === next.token ? cur : next));
    };
    chrome.storage.local.onChanged.addListener(onChange);
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, []);
  const transport = useMemo(() => (settings && ready(settings) ? localTransport(settings) : undefined), [settings]);
  if (!settings) return <p role="status">Starting Drishti…</p>;
  if (!transport) return <FinishSetup />;
  return <App transport={transport} onMicError={openMicGrant} onMicReady={micReady} />;
}

createRoot(document.getElementById("root")!).render(<Panel />);
