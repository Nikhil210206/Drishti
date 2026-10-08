/**
 * The global shortcuts (manifest `commands`), handled in the background: Chrome delivers them
 * even while focus is in the web page, which is where screen-reader users usually are.
 *
 *   Alt+Shift+D  open Drishti; once open, start and stop talking
 *   Alt+Shift+S  stop
 *   Alt+Shift+Y  yes to Drishti's question
 *   Alt+Shift+N  no
 *
 * The panel gets them as runtime messages. A shortcut press is a user gesture for Chrome, so
 * when the question is "may Drishti work on this site?", Yes asks Chrome for the site right
 * here: the panel itself has no gesture when the user isn't in it.
 */
export const COMMANDS = ["talk", "stop", "yes", "no"] as const;
export type Command = (typeof COMMANDS)[number];

export interface CommandMessage {
  type: "drishti-command";
  command: Command;
  /** The browser window the shortcut was pressed in. */
  windowId?: number;
}

export interface CommandDeps {
  openPanel(windowId: number): void;
  /** chrome.permissions.request: must start inside the key press, before anything is awaited. */
  request(origins: string[]): Promise<boolean>;
  send(msg: CommandMessage): void;
}

export class Commands {
  /** Origins of the site the panel is asking about, if it is. */
  private pending: string[] | null = null;

  constructor(private deps: CommandDeps) {}

  setPending(origins: string[] | null) {
    this.pending = origins?.length ? origins : null;
  }

  handle(command: string, windowId?: number) {
    if (!(COMMANDS as readonly string[]).includes(command)) return;
    const send = (c: Command) => this.deps.send({ type: "drishti-command", command: c, windowId });
    // Opening an open panel changes nothing; a closed one opens (this press only opens it).
    if (command === "talk" && windowId !== undefined) this.deps.openPanel(windowId);
    const origins = this.pending;
    if (command === "yes" && origins) {
      this.pending = null;
      this.deps.request(origins).then(
        (allowed) => send(allowed ? "yes" : "no"),
        // No gesture here either: the panel's own yes path takes over (it asks for the button).
        () => send("yes"),
      );
      return;
    }
    if (command === "no") this.pending = null;
    send(command as Command);
  }
}
