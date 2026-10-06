import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The extension bundles everything reachable from src/index.ts. Node APIs there would break the
// side panel at load time, so they live only in src/node.ts.
const SRC = path.join(import.meta.dirname, "../src");
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe("browser-safe providers", () => {
  const browserFiles = files(SRC).filter((f) => f.endsWith(".ts") && path.basename(f) !== "node.ts");

  it.each(browserFiles.map((f) => [path.relative(SRC, f), f]))("%s uses no Node APIs", (_name, file) => {
    const code = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/from\s+"node:|from\s+"(ws|fs|path|os|crypto|events)"|\brequire\(|\bBuffer\b|\bprocess\.|NodeJS\./);
  });

  it("nothing in the browser entry imports node.ts", () => {
    for (const f of browserFiles) expect(fs.readFileSync(f, "utf8")).not.toMatch(/from\s+"\.\.?\/(\.\.\/)?node(\.js)?"/);
  });
});
