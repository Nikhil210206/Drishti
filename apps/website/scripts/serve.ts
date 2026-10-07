/** Serve public/ on http://localhost:5175 (the connect page's local origin, allowed by the proxy). */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "../public");
const PORT = Number(process.env.WEBSITE_PORT ?? 5175);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let file = path.normalize(path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(ROOT)) return void res.writeHead(403).end();
    if (!path.extname(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return void res.writeHead(404).end("Not found");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Drishti website → http://localhost:${PORT}/`));
