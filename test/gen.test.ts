import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { estimate, generate, spendTotals } from "../src/gen/generate.ts";
import { StudioError } from "../src/model/types.ts";

const dir = () => mkdtempSync(join(tmpdir(), "studio-gen-"));
const tinyPng = PNG.sync.write(Object.assign(new PNG({ width: 2, height: 2 }), {}));

test("estimate uses the price table", () => {
  assert.equal(estimate({ provider: "openai", count: 4 }), 0.168);
  assert.equal(estimate({ provider: "mock", count: 3 }), 0);
  assert.equal(estimate({ provider: "gemini", count: 2 }), 0.08);
});

test("mock writes N images and logs one zero-cost studio line", async () => {
  const d = dir(), ledger = join(d, "spend.jsonl");
  const r = await generate({ provider: "mock", prompt: "robot mark", count: 3 }, { outDir: join(d, "refs"), ledgerPath: ledger, project: "demo" });
  assert.equal(r.images.length, 3);
  for (const p of r.images) assert.ok(existsSync(p));
  const lines = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].usd, 0);
  assert.equal(lines[0].source, "studio");
  assert.ok(lines[0].at && lines[0].model && lines[0].where);
});

test("openai adapter sends gpt-image-1 and logs the priced cost", async () => {
  const d = dir(), ledger = join(d, "spend.jsonl");
  let sent: any;
  const fetch = async (_url: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: [{ b64_json: tinyPng.toString("base64") }, { b64_json: tinyPng.toString("base64") }] }), { status: 200 });
  };
  const r = await generate({ provider: "openai", prompt: "x", count: 2 },
    { outDir: join(d, "refs"), ledgerPath: ledger, project: "demo", fetch: fetch as any, env: { OPENAI_API_KEY: "sk-test" } });
  assert.equal(sent.model, "gpt-image-1");
  assert.equal(sent.n, 2);
  assert.equal(r.usd, 0.084);
  assert.equal(JSON.parse(readFileSync(ledger, "utf8").trim()).usd, 0.084);
});

test("a failed paid call logs nothing", async () => {
  const d = dir(), ledger = join(d, "spend.jsonl");
  const fetch = async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 });
  await assert.rejects(generate({ provider: "openai", prompt: "x", count: 1 },
    { outDir: join(d, "refs"), ledgerPath: ledger, project: "demo", fetch: fetch as any, env: { OPENAI_API_KEY: "k" } }), /bad/);
  assert.equal(existsSync(ledger), false);
});

test("gemini without a key is a no_key error", async () => {
  const d = dir();
  await assert.rejects(generate({ provider: "gemini", prompt: "x", count: 1 }, { outDir: d, ledgerPath: join(d, "l"), project: "p", env: {} }),
    (e: unknown) => e instanceof StudioError && e.code === "no_key" && /GEMINI_API_KEY/.test(e.message));
});

test("spendTotals counts only studio lines, today and all time", () => {
  const d = dir(), ledger = join(d, "spend.jsonl");
  const today = new Date().toISOString();
  writeFileSync(ledger, [
    { at: today, usd: 0.1, model: "m", source: "studio", where: "x" },
    { at: "2026-01-01T00:00:00Z", usd: 0.2, model: "m", source: "studio", where: "x" },
    { at: today, usd: 5, model: "gpt", source: "bringup", where: "run" },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const t = spendTotals(ledger);
  assert.equal(t.today, 0.1);
  assert.ok(Math.abs(t.all - 0.3) < 1e-9);
});

test("POST /api/gen with mock stores refs, logs feedback, and spend reads the ledger", async () => {
  const { startServer } = await import("../src/server/app.ts");
  await import("../src/server/routes.ts");
  const d = dir();
  process.env.STUDIO_LEDGER = join(d, "spend.jsonl");
  const srv = await startServer({ root: d, port: 0, project: "demo", watch: false });
  try {
    const r = await (await fetch(srv.url + "/api/gen", { method: "POST", body: JSON.stringify({ prompt: "mark", provider: "mock", count: 2 }) })).json();
    assert.equal(r.images.length, 2);
    assert.deepEqual((await (await fetch(srv.url + "/api/refs")).json()).length, 2);
    const fb = await (await fetch(srv.url + "/api/feedback?since=0")).json();
    assert.equal(fb.items.at(-1).kind, "generate");
    assert.deepEqual(await (await fetch(srv.url + "/api/spend")).json(), { today: 0, all: 0 });
    assert.equal((await (await fetch(srv.url + "/api/gen/estimate?provider=openai&count=4")).json()).usd, 0.168);
  } finally { await srv.close(); delete process.env.STUDIO_LEDGER; }
});
