import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { LangCode, Profile } from "@drishti/core";

export interface Expect {
  /** Fields of the single booking that must exist. "a|b" accepts either. Date: "+1" = tomorrow of the fixed eval date. */
  booking?: Record<string, string | number>;
  /** The run must not create any booking (search tasks, declined payments). */
  no_booking?: boolean;
  complaint?: boolean | { category?: string; text_includes?: string };
  no_complaint?: boolean;
  /** The final reply must contain at least one of these (case-insensitive). */
  say_any?: string[];
  /** Something Drishti said during the task (not only the final reply) contains one of these. */
  spoken_any?: string[];
  /** The final reply must contain all of these. */
  say_all?: string[];
  /** The agent must ask the user something (ambiguous request). */
  asks?: boolean;
  /** Regex (case-insensitive): the agent must never successfully click a control whose name matches. */
  no_click?: string;
  outcome?: "done" | "stuck" | "aborted";
  max_steps?: number;
}

export interface Task {
  id: string;
  lang: LangCode;
  /** "pathik" (default) or a saved site under fixtures/sites, e.g. "sites/hi-wikipedia-bharat/". */
  start?: string;
  command: string;
  /** Replies to ask_user questions, in order. */
  answers?: string[];
  /** Replies to confirmation questions, in order; after they run out, `confirm_default` (default "haan"). */
  confirms?: string[];
  confirm_default?: string;
  /** Text "dictated" into the compose box. */
  compose?: string;
  /** "test" (default) uses a fictional passenger; "none" gives the agent no profile. */
  profile?: "test" | "none";
  tags?: string[];
  expect: Expect;
}

export const TEST_PROFILE: Profile = { name: "Asha Verma", age: "34", gender: "Female", mobile: "9000000001" };

export function loadTasks(dir: string): Task[] {
  const tasks: Task[] = [];
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => /\.ya?ml$/.test(n))
    .sort()) {
    const list: Task[] = YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")) ?? [];
    for (const t of list) tasks.push({ ...t, tags: [...(t.tags ?? []), path.basename(f).replace(/\.ya?ml$/, "")] });
  }
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) throw new Error(`duplicate task id ${t.id}`);
    seen.add(t.id);
  }
  return tasks;
}
