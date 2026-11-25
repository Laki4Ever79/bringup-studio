import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startServer } from "../src/server/app.ts";
import { btn, tokens } from "./fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "studio-srv-"));
const srv = await startServer({ root, port: 0, project: "demo" });
after(() => srv.close());

const call = (path: string, init: RequestInit & { session?: string } = {}) =>
  fetch(srv.url + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.session ? { "x-studio-session": init.session } : {}) },
  });

test("PUT then GET an element; tokens round-trip", async () => {
  assert.equal((await call("/api/tokens", { method: "PUT", body: JSON.stringify(tokens), session: "a" })).status, 200);
  const put = await call("/api/elements/btn", { method: "PUT", body: JSON.stringify(btn), session: "a" });
  assert.equal(put.status, 200);
  const got = await (await call("/api/elements/btn")).json();
  assert.equal(got.id, "btn");
  assert.deepEqual(await (await call("/api/elements")).json(), ["btn"]);
});

test("writes without a session header are refused", async () => {
  const r = await call("/api/elements/btn/params", { method: "POST", body: JSON.stringify({ values: { stroke: 3 } }) });
  assert.equal(r.status, 400);
});

test("another session gets 423 naming the lock holder", async () => {
  assert.equal((await call("/api/lock", { method: "POST", body: "{}", session: "a" })).status, 200);
  const r = await call("/api/elements/btn/params", { method: "POST", body: JSON.stringify({ values: { stroke: 3 } }), session: "b" });
  assert.equal(r.status, 423);
  assert.equal((await r.json()).holder, "a");
  assert.equal((await call("/api/lock", { method: "DELETE", session: "a" })).status, 200);
});

test("feedback is appended and read with a cursor", async () => {
  await call("/api/feedback", { method: "POST", body: JSON.stringify({ kind: "pick", element: "btn", variant: "thick" }) });
  const r = await (await call("/api/feedback?since=0")).json();
  assert.equal(r.cursor, 1);
  assert.equal(r.items[0].kind, "pick");
  assert.ok(r.items[0].at);
  const none = await (await call("/api/feedback?since=1")).json();
  assert.equal(none.items.length, 0);
});

test("a malformed feedback body is a 400, not a crash", async () => {
  const r = await call("/api/feedback", { method: "POST", body: JSON.stringify({ kind: "nope" }) });
  assert.equal(r.status, 400);
  assert.equal((await call("/api/elements")).status, 200);
});

test("ws clients get a reload after a params change, and show reports clients", async () => {
  const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws");
  await new Promise((res) => ws.once("open", res));
  const got = new Promise<any>((res) => ws.on("message", (m) => {
    const msg = JSON.parse(String(m));
    if (msg.type === "reload") res(msg);
  }));
  const t0 = Date.now();
  await call("/api/elements/btn/params", { method: "POST", body: JSON.stringify({ values: { stroke: 4 } }), session: "a" });
  const msg = await got;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(msg.element, "btn");
  const show = await (await call("/api/show", { method: "POST", body: JSON.stringify({ view: "board", element: "btn" }) })).json();
  assert.equal(show.clients, 1);
  ws.close();
});

test("element preview serves a standalone page", async () => {
  const html = await (await call("/preview/element/btn?theme=dark&variant=thick")).text();
  assert.match(html, /data-theme="dark"/);
  assert.match(html, /--btn-stroke:3px/);
  assert.equal((await call("/preview/element/ghost")).status, 404);
});

test("cross-site requests are refused: foreign Host, foreign Origin, non-JSON writes", async () => {
  const port = new URL(srv.url).port;
  const { request } = await import("node:http");
  const raw = (headers: Record<string, string>, method = "POST", path = "/api/feedback") => new Promise<number>((res) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, (x) => { x.resume(); res(x.statusCode!); });
    r.end(method === "GET" ? undefined : JSON.stringify({ kind: "pick" }));
  });
  assert.equal(await raw({ host: "evil.example:" + port }, "GET", "/api/elements"), 403);
  assert.equal(await raw({ "content-type": "application/json", origin: "https://evil.example" }), 403);
  assert.equal(await raw({ "content-type": "text/plain" }), 415);
  assert.equal(await raw({ "content-type": "application/json", origin: srv.url }), 200);
  assert.equal(await raw({ host: "localhost:" + port }, "GET", "/api/elements"), 200);
});

test("query values are never reflected as markup", async () => {
  const evil = encodeURIComponent('"><script>alert(1)</script>');
  const el = await (await call(`/preview/element/btn?lang=${evil}`)).text();
  assert.doesNotMatch(el, /<script>alert/);
});
