/**
 * The first microphone grant (spike 1): Chrome never shows the prompt inside the side panel, but
 * an extension tab can, and the grant then covers the panel too. This tab does not close itself:
 * "Allow this time" is revoked when the tab closes, so it stays until the panel reports that the
 * mic is really capturing.
 */
const status = document.getElementById("status")!;
const again = document.getElementById("again") as HTMLButtonElement;

// Screen-reader users hear the live region; everyone else hears this.
function say(text: string) {
  status.textContent = text;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

async function ask() {
  again.hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    say(
      "Microphone allowed. Go back to Drishti in the side panel and hold Space to talk. This tab closes by itself once Drishti hears you.",
    );
  } catch (e) {
    say(`The microphone was not allowed. Press "Ask again" and choose "Allow while visiting the site". (${(e as Error).name})`);
    again.hidden = false;
    again.focus();
  }
}

again.addEventListener("click", () => void ask());
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "drishti-mic-ok") window.close();
});
say(status.textContent ?? "");
void ask();
