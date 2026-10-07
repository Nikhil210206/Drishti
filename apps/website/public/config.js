// Where this copy of the website sends people. Local development values; the deployed site sets
// its own proxy address and its Turnstile site key (docs/proxy.md).
window.DRISHTI_CONFIG = {
  proxy: "http://localhost:8788",
  // Cloudflare's always-pass test key: works on localhost, never deploy it.
  turnstileSiteKey: "1x00000000000000000000AA",
};
