import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@drishti/ui";
import "@drishti/ui/styles.css";
import { localTransport } from "../../lib/panel-session";
import { loadSettings, saveSettings, type Settings } from "../../lib/settings";

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

/** Until sign-in through the website exists: the proxy address and a hand-minted device token. */
function DevSetup({ initial, onSaved }: { initial: Settings; onSaved: (s: Settings) => void }) {
  const [proxyUrl, setProxyUrl] = useState(initial.proxyUrl);
  const [token, setToken] = useState(initial.token);
  return (
    <main className="dev-setup" style={{ padding: 16, fontSize: 16 }}>
      <h1>Set up Drishti (developer)</h1>
      <p>Drishti needs its proxy address and a device token. Mint one with apps/proxy/scripts/mint.ts.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          onSaved(await saveSettings({ proxyUrl: proxyUrl.trim(), token: token.trim() }));
        }}
      >
        <label style={{ display: "block", marginTop: 12 }}>
          Proxy address
          <input value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} style={{ display: "block", width: "100%" }} />
        </label>
        <label style={{ display: "block", marginTop: 12 }}>
          Device token
          <input value={token} onChange={(e) => setToken(e.target.value)} style={{ display: "block", width: "100%" }} />
        </label>
        <button type="submit" style={{ marginTop: 16 }} disabled={!proxyUrl.trim() || !token.trim()}>
          Save and start
        </button>
      </form>
    </main>
  );
}

function Panel() {
  const [settings, setSettings] = useState<Settings | undefined>();
  useEffect(() => void loadSettings().then(setSettings), []);
  const transport = useMemo(() => (settings?.token ? localTransport(settings) : undefined), [settings]);
  if (!settings) return <p role="status">Starting Drishti…</p>;
  if (!transport) return <DevSetup initial={settings} onSaved={setSettings} />;
  return <App transport={transport} onMicError={openMicGrant} onMicReady={micReady} />;
}

createRoot(document.getElementById("root")!).render(<Panel />);
