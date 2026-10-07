// Gets this Drishti extension a device token: Cloudflare Turnstile checks for a person (usually
// with nothing to do), the proxy mints a token, and the token goes straight to the extension that
// opened this page (?ext=<extension id>). Nothing is stored on this site.
(function () {
  const cfg = window.DRISHTI_CONFIG;
  const params = new URLSearchParams(location.search);
  const ext = params.get("ext");
  const hindi = (params.get("lang") || "").startsWith("hi");
  const statusEl = document.getElementById("status");

  const TEXT = {
    checking: [
      "Checking that you are a person. This usually needs nothing from you.",
      "जाँच रहे हैं कि आप इंसान हैं। आम तौर पर आपको कुछ नहीं करना होता।",
    ],
    noExt: ["Open this page from the Drishti extension.", "यह पेज Drishti एक्सटेंशन से खोलिए।"],
    connecting: ["Connecting your Drishti.", "आपका Drishti जोड़ रहे हैं।"],
    done: [
      "Drishti is connected. This tab will close; Drishti continues in its own tab.",
      "Drishti जुड़ गया। यह टैब बंद हो जाएगा, Drishti अपने टैब में आगे बढ़ेगा।",
    ],
    failed: ["Could not connect Drishti. Please try again in a minute.", "Drishti नहीं जुड़ पाया। एक मिनट बाद फिर कोशिश कीजिए।"],
    challenge: ["Cloudflare needs you to press the checkbox below to continue.", "आगे बढ़ने के लिए नीचे वाले बॉक्स को दबाइए।"],
  };
  const say = (key, extra) => {
    const text = TEXT[key][hindi ? 1 : 0] + (extra ? ` (${extra})` : "");
    statusEl.textContent = text;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = hindi ? "hi-IN" : "en-IN";
      speechSynthesis.speak(u);
    } catch (e) {}
  };

  if (hindi) document.documentElement.lang = "hi";
  if (!ext || !/^[a-p]{32}$/.test(ext) || !window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
    say("noExt");
    return;
  }
  say("checking");

  async function mint(turnstile) {
    say("connecting");
    try {
      const res = await fetch(`${cfg.proxy}/v1/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnstile }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.token) throw new Error(body.error || `HTTP ${res.status}`);
      chrome.runtime.sendMessage(ext, { type: "drishti-token", token: body.token }, (reply) => {
        if (chrome.runtime.lastError || !reply || !reply.ok)
          return say("failed", chrome.runtime.lastError ? chrome.runtime.lastError.message : "");
        say("done");
        setTimeout(() => window.close(), 4000);
      });
    } catch (e) {
      say("failed", e.message);
    }
  }

  function render() {
    turnstile.render("#turnstile", {
      sitekey: cfg.turnstileSiteKey,
      language: hindi ? "hi" : "en",
      callback: mint,
      "before-interactive-callback": () => say("challenge"),
      "error-callback": () => say("failed", "Turnstile"),
    });
  }
  if (window.turnstile) render();
  else window.addEventListener("load", () => (window.turnstile ? render() : say("failed", "Turnstile did not load")));
})();
