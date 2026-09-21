// Serves dist/ locally so you can point the extension at http://localhost:8080/index.json before publishing.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { DIST } = require("./build");

const TYPES = { ".json": "application/json", ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const port = Number(process.env.PORT) || 8080;

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(DIST, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Registry served at http://localhost:${port}/index.json  (Ctrl+C to stop)`));
