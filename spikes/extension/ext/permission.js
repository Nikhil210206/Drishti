// Extension-tab fallback: a normal tab can show Chrome's permission prompt; once the
// extension origin has mic access, the side panel can use it too.
const status = document.getElementById("status");
navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((s) => {
    s.getTracks().forEach((t) => t.stop());
    status.textContent = "Microphone allowed. You can close this tab and go back to the side panel.";
    setTimeout(() => window.close(), 2500);
  })
  .catch((e) => (status.textContent = `Microphone not allowed: ${e.name}. ${e.message}`));
