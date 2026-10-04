import type { ToolDef } from "../types.js";

const narration = {
  type: "string",
  description: 'What you are doing, max 6 words, in the user\'s language. Spoken while the action runs. Use "" to stay silent.',
};
const id = { type: "integer", description: "Element id from PAGE STATE, e.g. 12 for [12]" };

const fn = (name: string, description: string, properties: Record<string, any>, required: string[]): ToolDef => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const TOOLS: ToolDef[] = [
  fn(
    "click",
    "Click an element. If the click pays, books, submits, sends or deletes something, you MUST fill confirmation_question.",
    {
      id,
      narration,
      confirmation_question: {
        type: "string",
        description:
          "ONLY for clicks that pay, book, submit, send or delete: the yes/no question to ask the user, in their language, with amount and key details. Leave empty for everything else.",
      },
    },
    ["id", "narration"],
  ),
  fn(
    "type_text",
    "Type into a text box (replaces its content). For autocomplete boxes, suggestions appear on the next turn — then click the right one.",
    { id, text: { type: "string" }, submit: { type: "boolean", description: "Press Enter after typing" }, narration },
    ["id", "text", "narration"],
  ),
  fn(
    "fill_form",
    "Fill several plain text fields at once (names, ages, phone numbers). Not for station/autocomplete boxes, dates or buttons. Stops early if suggestions pop up.",
    {
      fields: {
        type: "array",
        items: { type: "object", properties: { id: { type: "integer" }, value: { type: "string" } }, required: ["id", "value"] },
      },
      narration,
    },
    ["fields", "narration"],
  ),
  fn(
    "select_option",
    "Choose an option in a dropdown (native select or custom dropdown) by its visible text.",
    { id, option: { type: "string" }, narration },
    ["id", "option", "narration"],
  ),
  fn("press_key", "Press a keyboard key, e.g. Enter, Escape, Tab, ArrowDown.", { key: { type: "string" }, narration }, [
    "key",
    "narration",
  ]),
  fn("scroll", "Scroll the page to see more content.", { direction: { type: "string", enum: ["up", "down"] }, narration }, [
    "direction",
    "narration",
  ]),
  fn("go_back", "Go back to the previous page.", { narration }, ["narration"]),
  fn("navigate", "Open a URL (only websites the user asked for).", { url: { type: "string" }, narration }, ["url", "narration"]),
  fn(
    "read_page",
    'Get the full readable text of a long page (article, notice, scheme details) when PAGE STATE is not enough to answer. NOT for looking around: PAGE STATE already shows the page. mode=summary (default) returns the text to you so you can answer. mode=verbatim reads the page aloud word for word and is slow and costly: ONLY when the user explicitly asks to hear the exact words ("read it out", "word for word"), never for a question or "what is on this page".',
    { mode: { type: "string", enum: ["summary", "verbatim"] }, narration },
    ["mode", "narration"],
  ),
  fn(
    "read_document",
    "Read a PDF/scanned document linked on the page with Sarvam Vision (OCR, 23 languages). Returns its text so you can explain it.",
    {
      id: { type: "integer", description: "id of the link to the document" },
      language: { type: "string", description: "BCP-47 language of the document if known, e.g. bn-IN" },
      narration,
    },
    ["id", "narration"],
  ),
  fn(
    "ask_user",
    "Ask the user a short question and wait for their spoken answer (missing details, choosing among options).",
    { question: { type: "string", description: "In the user's language. Offer choices when possible." } },
    ["question"],
  ),
  fn(
    "compose_with_kivi",
    "For long free text the user must write themselves (complaint, message, feedback, address). The user dictates it with Kivi, Drishti reads it back, and fills the field after they approve.",
    { id, what: { type: "string", description: "What to write, e.g. 'your complaint', in the user's language" } },
    ["id", "what"],
  ),
  fn(
    "done",
    "Finish: say the result or answer to the user. Short (max 3 sentences), in the user's language.",
    { speech: { type: "string" } },
    ["speech"],
  ),
];
