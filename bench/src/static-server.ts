import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { createGzip } from "node:zlib";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".parquet": "application/octet-stream",
  ".arrow": "application/vnd.apache.arrow.file",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = new Set([
  ".html",
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".svg",
  ".wasm",
  ".txt",
  ".arrow",
]);

export interface StaticServer {
  url: string;
  close(): Promise<void>;
}

export function serveStatic(root: string, port = 0): Promise<StaticServer> {
  const server: Server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      response.writeHead(403).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    const extension = extname(file);
    const gzip =
      COMPRESSIBLE.has(extension) &&
      /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""));
    response.writeHead(200, {
      "content-type": TYPES[extension] ?? "application/octet-stream",
      "cache-control": "no-cache",
      ...(gzip
        ? { "content-encoding": "gzip", vary: "accept-encoding" }
        : { "content-length": statSync(file).size }),
    });
    const stream = createReadStream(file);
    if (gzip) stream.pipe(createGzip({ level: 6 })).pipe(response);
    else stream.pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
