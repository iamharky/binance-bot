// HTTP server: the control API under /api (JSON, session cookie required except /api/login), a server-sent event
// stream at /api/stream, and the UI's static files from public/. Mutating requests must carry
// `X-Requested-With: binance-bot` (with the SameSite=Strict cookie this keeps other sites from driving the API).
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { ROOT } from "../config.js";
import { ConfigError } from "../engine.js";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const PUBLIC = join(ROOT, "public");
const MAX_BODY = 64 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(json);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(c);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};

/** routes: [{method, path (string with :params), handler(ctx) -> body, public?}] */
export function createHttpServer({ auth, routes, sse, trustProxy = false }) {
  const compiled = routes.map((r) => {
    const keys = [];
    const re = new RegExp(`^${r.path.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), "([^/]+)"))}$`);
    return { ...r, re, keys };
  });

  return createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path.startsWith("/api/")) {
        const route = compiled.find((r) => r.method === req.method && r.re.test(path));
        if (!route) throw new HttpError(404, `No route ${req.method} ${path}`);
        const session = auth.session(req);
        if (!route.public && !session) throw new HttpError(401, "Log in first");
        if (req.method !== "GET" && req.headers["x-requested-with"] !== "binance-bot") throw new HttpError(403, "Missing X-Requested-With header");
        if (route.stream) {
          sse(req, res);
          return;
        }
        const m = route.re.exec(path);
        const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
        const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body, ip: clientIp(req, trustProxy), session };
        const out = await route.handler(ctx);
        if (!res.headersSent) send(res, 200, out ?? { ok: true }, ctx.headers ?? {});
        return;
      }
      // Static UI. Everything but the login page needs a session.
      let file = path === "/" ? "/index.html" : path;
      if (file === "/login") file = "/login.html";
      const isLogin = file === "/login.html" || file === "/login.js" || file === "/styles.css" || file === "/favicon.svg";
      if (!isLogin && !auth.session(req)) {
        res.writeHead(302, { Location: "/login" });
        res.end();
        return;
      }
      const full = normalize(join(PUBLIC, file));
      if (!full.startsWith(PUBLIC) || !existsSync(full) || !statSync(full).isFile()) throw new HttpError(404, "Not found");
      res.writeHead(200, { "Content-Type": MIME[extname(full)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      createReadStream(full).pipe(res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof ConfigError ? 400 : typeof e.status === "number" ? e.status : 500;
      if (status >= 500) console.error(e);
      if (!res.headersSent) send(res, status, { ok: false, error: e.message, ...(e.field ? { field: e.field } : {}) });
      else res.end();
    }
  });
}
