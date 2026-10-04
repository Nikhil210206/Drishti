/** Print the eval task set: `npx tsx eval/list-tasks.ts` */
import path from "node:path";
import { ROOT } from "../apps/dev-harness/src/config.js";
import { loadTasks } from "./lib/tasks.js";

const tasks = loadTasks(path.join(ROOT, "eval/tasks"));
const count = (key: (t: (typeof tasks)[number]) => string[]) => {
  const m: Record<string, number> = {};
  for (const t of tasks) for (const k of key(t)) m[k] = (m[k] ?? 0) + 1;
  return m;
};
console.log(`${tasks.length} tasks`);
console.log(
  "by file:",
  count((t) => (t.tags ?? []).slice(-1)),
);
console.log(
  "by language:",
  count((t) => [t.lang]),
);
