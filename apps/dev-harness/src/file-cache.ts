import fs from "node:fs";
import path from "node:path";
import type { Cache } from "@drishti/core";

/** JSON-file Cache for fixed-phrase translations (never user content). */
export class FileCache implements Cache {
  private data: Record<string, string>;

  constructor(private file: string) {
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  }

  async get(key: string) {
    return this.data[key];
  }

  async set(key: string, value: string) {
    this.data[key] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
  }
}
