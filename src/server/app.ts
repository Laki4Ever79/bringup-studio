import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "../model/store.ts";
import { elementPage } from "../model/compile.ts";
import { StudioError } from "../model/types.ts";
import { FeedbackLog } from "./feedback.ts";
import { Lock } from "./lock.ts";
import { watchProject } from "./watch.ts";

export const STUDIO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export type Ctx = {
  root: string;
  project: string;
  projectDir: string;
  store: Store;
  feedback: FeedbackLog;
  lock: Lock;
  url: string;
  broadcast(msg: object): number;
  config(): ProjectConfig;
  state: { status?: object; show?: object };
};

export type ProjectConfig = { site?: string; fontsHref?: string; baseCss?: string };

type Handler = (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, ctx: Ctx, q: URLSearchParams) => Promise<unknown> | unknown;
type Route = { method: string; path: RegExp; handler: Handler; write?: boolean; raw?: boolean };

const routes: Route[] = [];
/** Register a route. `write` routes require a session and the lock; `raw` routes write their own response. */
export function route(method: string, path: RegExp, handler: Handler, opts: { write?: boolean; raw?: boolean } = {}) {
  routes.push({ method, path, handler, ...opts });
}

export async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw new StudioError("bad_json", "request body is not valid JSON"); }
}

const STATUS: Record<string, number> = {
  not_found: 404, locked: 423, no_session: 400, bad_json: 400, invalid_file: 400, bad_param: 400, bad_id: 400,
  hand_edited: 409, no_key: 412, no_site: 412, not_adopted: 409,
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".gif": "image/gif", ".webp": "image/webp", ".jpg": "image/jpeg",
};

export function sendFile(res: ServerResponse, file: string) {
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
}

// ---- core routes ----------------------------------------------------------------------------------------
route("GET", /^\/api\/elements$/, (_q, _r, _m, ctx) => ctx.store.list());
route("GET", /^\/api\/elements\/([a-z][a-z0-9-]*)$/, (_q, _r, m, ctx) => ctx.store.get(m[1]));
route("PUT", /^\/api\/elements\/([a-z][a-z0-9-]*)$/, async (req, _r, m, ctx) => {
  const e = await body(req);
  ctx.store.put({ ...e, id: m[1] });
  ctx.broadcast({ type: "reload", element: m[1] });
  return { ok: true };
}, { write: true });
route("DELETE", /^\/api\/elements\/([a-z][a-z0-9-]*)$/, (_q, _r, m, ctx) => {
  ctx.store.remove(m[1]);
  ctx.broadcast({ type: "reload" });
  return { ok: true };
}, { write: true });
route("POST", /^\/api\/elements\/([a-z][a-z0-9-]*)\/params$/, async (req, _r, m, ctx) => {
  const b = await body(req);
  const e = ctx.store.setParams(m[1], b.values ?? {}, b.variant);
  ctx.broadcast({ type: "reload", element: m[1] });
  return e;
}, { write: true });
route("GET", /^\/api\/tokens$/, (_q, _r, _m, ctx) => ctx.store.tokens());
route("PUT", /^\/api\/tokens$/, async (req, _r, _m, ctx) => {
  ctx.store.setTokens(await body(req));
  ctx.broadcast({ type: "reload" });
  return { ok: true };
}, { write: true });
route("GET", /^\/api\/strings$/, (_q, _r, _m, ctx) => ctx.store.strings());
route("GET", /^\/api\/feedback$/, (_q, _r, _m, ctx, q) => ctx.feedback.since(Number(q.get("since") ?? 0)));
route("POST", /^\/api\/feedback$/, async (req, _r, _m, ctx) => {
  const f = ctx.feedback.add(await body(req));
  ctx.broadcast({ type: "feedback", item: f });
  return f;
});
route("POST", /^\/api\/show$/, async (req, _r, _m, ctx) => {
  const msg = { type: "show", ...(await body(req)) };
  ctx.state.show = msg;
  return { clients: ctx.broadcast(msg) };
});
route("POST", /^\/api\/status$/, async (req, _r, _m, ctx) => {
  const b = await body(req);
  const msg = { type: "status", session: b.session ?? req.headers["x-studio-session"], text: String(b.text ?? ""), at: new Date().toISOString() };
  ctx.state.status = msg;
  ctx.broadcast(msg);
  return { ok: true };
});
route("GET", /^\/api\/lock$/, (_q, _r, _m, ctx) => ({ holder: ctx.lock.current() }));
route("POST", /^\/api\/lock$/, (req, _r, _m, ctx) => {
  ctx.lock.check(req.headers["x-studio-session"] as string | undefined);
  ctx.broadcast({ type: "lock", holder: ctx.lock.current() });
  return { holder: ctx.lock.current() };
});
route("DELETE", /^\/api\/lock$/, (req, _r, _m, ctx) => {
  ctx.lock.release(String(req.headers["x-studio-session"] ?? ""));
  ctx.broadcast({ type: "lock", holder: ctx.lock.current() });
  return { holder: ctx.lock.current() };
});
route("GET", /^\/api\/snapshots$/, (_q, _r, _m, ctx) => ctx.store.snapshots());
route("POST", /^\/api\/snapshots$/, async (req, _r, _m, ctx) => {
  ctx.store.snapshot(String((await body(req)).name));
  return { ok: true };
}, { write: true });
route("POST", /^\/api\/restore$/, async (req, _r, _m, ctx) => {
  ctx.store.restore(String((await body(req)).name));
  ctx.broadcast({ type: "reload" });
  return { ok: true };
}, { write: true });
route("GET", /^\/api\/state$/, (_q, _r, _m, ctx) => ({ project: ctx.project, holder: ctx.lock.current(), ...ctx.state }));

route("GET", /^\/preview\/element\/([a-z][a-z0-9-]*)$/, (_req, res, m, ctx, q) => {
  const cfg = ctx.config();
  const html = elementPage({
    tokens: ctx.store.tokens(), el: ctx.store.get(m[1]), variant: q.get("variant") || undefined,
    theme: q.get("theme") === "dark" ? "dark" : "light", lang: q.get("lang") ?? "en", strings: ctx.store.strings(),
    fontsHref: cfg.fontsHref, baseCss: cfg.baseCss, pad: q.has("pad") ? Number(q.get("pad")) : undefined,
  });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}, { raw: true });

// project reference images (generated or traced sources)
route("GET", /^\/refs\/([A-Za-z0-9._-]+)$/, (_req, res, m, ctx) => {
  const f = join(ctx.projectDir, "refs", m[1]);
  if (!existsSync(f)) throw new StudioError("not_found", `no ref ${m[1]}`);
  sendFile(res, f);
}, { raw: true });

// ---- server ---------------------------------------------------------------------------------------------
export async function startServer(opts: { root: string; port: number; project: string; host?: string; watch?: boolean }) {
  const projectDir = join(opts.root, "projects", opts.project);
  mkdirSync(projectDir, { recursive: true });
  const clients = new Set<WebSocket>();
  const ctx: Ctx = {
    root: opts.root, project: opts.project, projectDir,
    store: new Store(projectDir),
    feedback: new FeedbackLog(join(projectDir, "feedback.jsonl")),
    lock: new Lock(),
    url: "",
    state: {},
    broadcast(msg) {
      const s = JSON.stringify(msg);
      let n = 0;
      for (const c of clients) if (c.readyState === WebSocket.OPEN) { c.send(s); n++; }
      return n;
    },
    config() {
      const p = join(projectDir, "project.json");
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
    },
  };
  const studioDir = join(STUDIO_ROOT, "studio");

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = u.pathname.match(r.path);
        if (!m) continue;
        if (r.write) ctx.lock.check(req.headers["x-studio-session"] as string | undefined);
        const out = await r.handler(req, res, m, ctx, u.searchParams);
        if (!r.raw) {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(out ?? { ok: true }));
        }
        return;
      }
      if (req.method === "GET") {
        const rel = u.pathname === "/" ? "index.html" : normalize(u.pathname).replace(/^[/\\]+/, "");
        const f = join(studioDir, rel);
        if (f.startsWith(studioDir) && existsSync(f)) return sendFile(res, f);
      }
      throw new StudioError("not_found", `no route ${req.method} ${u.pathname}`);
    } catch (e) {
      const err = e instanceof StudioError ? e : new StudioError("internal", (e as Error).message);
      if (!(e instanceof StudioError)) console.error(e);
      if (res.headersSent) return res.end();
      res.writeHead(STATUS[err.code] ?? 500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.code, message: err.message, ...(err.detail ?? {}) }));
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    if (!req.url?.startsWith("/ws")) return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.send(JSON.stringify({ type: "hello", project: ctx.project, holder: ctx.lock.current(), ...ctx.state }));
    });
  });

  const watcher = opts.watch === false ? null : watchProject(projectDir, (element) => ctx.broadcast({ type: "reload", element }));
  await new Promise<void>((res) => server.listen(opts.port, opts.host ?? "127.0.0.1", res));
  const addr = server.address();
  ctx.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : opts.port}`;
  return {
    url: ctx.url,
    ctx,
    async close() {
      await watcher?.close();
      for (const c of clients) c.terminate();
      wss.close();
      await new Promise((r) => server.close(() => r(null)));
    },
  };
}
