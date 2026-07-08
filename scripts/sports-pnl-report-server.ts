import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { PATHS } from "./lib/paths.js";

const PORT = Number(process.env.SPORTS_PNL_REPORT_PORT ?? 8765);
const HOST = process.env.SPORTS_PNL_REPORT_HOST ?? "127.0.0.1";
const REPORT_DIR = dirname(PATHS.pnlReportHtml);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = join(REPORT_DIR, pathname.replace(/^\/+/, ""));
    if (!filePath.startsWith(REPORT_DIR)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    const body = await readFile(filePath);
    const ext = pathname.split(".").pop()?.toLowerCase();
    const contentType = ext === "json" ? "application/json; charset=utf-8" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Sports P&L report: http://${HOST}:${PORT}/index.html`);
  console.log(`Serving ${REPORT_DIR}`);
});
