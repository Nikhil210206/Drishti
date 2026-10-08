import { describe, expect, it } from "vitest";
import { Commands, type CommandMessage } from "../lib/commands";

function setup(request: (o: string[]) => Promise<boolean> = async () => true) {
  const log: string[] = [];
  const sent: CommandMessage[] = [];
  const commands = new Commands({
    openPanel: (w) => void log.push(`open ${w}`),
    request: (o) => (log.push(`request ${o.join(" ")}`), request(o)),
    send: (m) => void sent.push(m),
  });
  return { commands, log, sent };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("global shortcuts", () => {
  it("talk opens the panel in that window and tells the panel", () => {
    const { commands, log, sent } = setup();
    commands.handle("talk", 7);
    expect(log).toEqual(["open 7"]);
    expect(sent).toEqual([{ type: "drishti-command", command: "talk", windowId: 7 }]);
  });

  it("passes stop, yes and no to the panel, and ignores anything else", () => {
    const { commands, log, sent } = setup();
    for (const c of ["stop", "yes", "no", "_execute_action"]) commands.handle(c, 1);
    expect(log).toEqual([]);
    expect(sent.map((m) => m.command)).toEqual(["stop", "yes", "no"]);
  });

  it("asks Chrome for a pending site inside the key press, then answers the panel", async () => {
    const { commands, log, sent } = setup(async () => true);
    commands.setPending(["https://*.irctc.co.in/*", "http://*.irctc.co.in/*"]);
    commands.handle("yes", 1);
    expect(log).toEqual(["request https://*.irctc.co.in/* http://*.irctc.co.in/*"]); // synchronously
    await flush();
    expect(sent.map((m) => m.command)).toEqual(["yes"]);
    // Asked once: a second yes is just a yes.
    commands.handle("yes", 1);
    expect(log).toHaveLength(1);
  });

  it("Deny in Chrome's box answers no; a failed request leaves the yes to the panel", async () => {
    const denied = setup(async () => false);
    denied.commands.setPending(["https://*.a.in/*"]);
    denied.commands.handle("yes");
    await flush();
    expect(denied.sent.map((m) => m.command)).toEqual(["no"]);

    const failed = setup(() => Promise.reject(new Error("no gesture")));
    failed.commands.setPending(["https://*.a.in/*"]);
    failed.commands.handle("yes");
    await flush();
    expect(failed.sent.map((m) => m.command)).toEqual(["yes"]);
  });
});
