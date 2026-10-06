/**
 * Mint a device token by hand, for testing a deployed proxy before the website's Turnstile check
 * exists. Needs the same TOKEN_SECRET the Worker has:
 *   TOKEN_SECRET=… npx tsx apps/proxy/scripts/mint.ts
 * Treat the output like a password: it spends your Sarvam credits until TOKEN_SECRET is rotated.
 */
import { mintToken } from "../src/token.js";

const secret = process.env.TOKEN_SECRET;
if (!secret) throw new Error("Set TOKEN_SECRET (the value given to `wrangler secret put TOKEN_SECRET`).");
const { token, device } = await mintToken(secret);
console.error(`device ${device}`);
console.log(token);
