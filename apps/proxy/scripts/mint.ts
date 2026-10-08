/**
 * Mint a device token by hand, for testing a deployed proxy without the website's Turnstile check.
 * Needs the same TOKEN_SECRET the Worker has, from the environment or apps/proxy/.token-secret
 * (gitignored; docs/proxy.md shows how to write it while setting the secret):
 *   npx tsx apps/proxy/scripts/mint.ts
 * Treat the output like a password: it spends your Sarvam credits until TOKEN_SECRET is rotated.
 */
import fs from "node:fs";
import path from "node:path";
import { mintToken } from "../src/token.js";

const file = path.join(import.meta.dirname, "../.token-secret");
const secret = process.env.TOKEN_SECRET ?? (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
if (!secret)
  throw new Error("Set TOKEN_SECRET, or write apps/proxy/.token-secret (the value given to `wrangler secret put TOKEN_SECRET`).");
const { token, device } = await mintToken(secret);
console.error(`device ${device}`);
console.log(token);
