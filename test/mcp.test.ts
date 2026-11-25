import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startServer } from "../src/server/app.ts";
import "../src/server/routes.ts";
import { closeRenderer } from "../src/render/render.ts";
import { createMcp, TOOL_NAMES } from "../src/mcp/server.ts";
import { btn, tokens } from "./fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "studio-mcp-"));
const srv = await startServer({ root, port: 0, project: "demo", watch: false });
srv.ctx.store.setTokens(tokens);
srv.ctx.store.put(btn);
const opened: string[] = [];
const mcp = createMcp({ base: srv.url, session: "test-session", open: async (u) => { opened.push(u); }, cursorDir: root, showWaitMs: 300 });
const [a, b] = InMemoryTransport.createLinkedPair();
await mcp.connect(a);
const client = new Client({ name: "t", version: "0" });
await client.connect(b);
after(async () => { await client.close(); await closeRenderer(); await srv.close(); });

const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ content: any[]; isError?: boolean }>;

test("lists every planned tool", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  for (const n of TOOL_NAMES) assert.ok(names.includes(n), `missing ${n}`);
  for (const n of ["studio_render", "studio_show", "studio_feedback", "studio_trace", "studio_generate", "studio_export", "studio_share"]) assert.ok(names.includes(n));
});

test("render returns image content", async () => {
  const r = await call("studio_render", { target: "element", id: "btn", theme: "dark" });
  assert.equal(r.isError ?? false, false);
  assert.ok(r.content.some((c) => c.type === "image" && c.mimeType === "image/png" && c.data.length > 100));
});

test("show with no studio tab opens the browser once", async () => {
  const r = await call("studio_show", { view: "board", element: "btn", note: "first look" });
  assert.equal(opened.length, 1);
  assert.match(opened[0], /#board\/btn$/);
  assert.match(r.content[0].text, /open .*#board\/btn/);
});

test("params_set writes through the session and errors come back readable", async () => {
  await call("studio_params_set", { id: "btn", values: { stroke: 7 } });
  assert.equal(srv.ctx.store.get("btn").params[0].value, 7);
  assert.equal(srv.ctx.lock.current(), "test-session");
  const bad = await call("studio_params_set", { id: "btn", values: { nope: 1 } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /unknown param "nope"/);
});

test("feedback reads only what is new since the last read", async () => {
  await fetch(srv.url + "/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "pick", element: "btn", variant: "thick" }) });
  const first = await call("studio_feedback");
  assert.match(first.content[0].text, /pick btn\/thick/);
  const second = await call("studio_feedback");
  assert.match(second.content[0].text, /no new feedback/);
});

test("show says plainly when the browser could not be opened, with the URL", async () => {
  const m2 = createMcp({ base: srv.url, session: "s2", open: async () => { throw new Error("xdg-open not found"); }, cursorDir: root, showWaitMs: 200 });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await m2.connect(x);
  const c2 = new Client({ name: "t2", version: "0" });
  await c2.connect(y);
  const r = await c2.callTool({ name: "studio_show", arguments: { view: "board", element: "btn" } }) as any;
  assert.match(r.content[0].text, /could not open a browser/i);
  assert.match(r.content[0].text, new RegExp(srv.url.replace(/[.]/g, "\\.")));
  await c2.close();
});
