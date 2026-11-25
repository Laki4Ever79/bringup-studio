import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/model/store.ts";
import { StudioError } from "../src/model/types.ts";
import { tokens, btn } from "./fixtures.ts";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "studio-store-"));
  return new Store(dir);
}

test("put/get round-trips an element and its variants", () => {
  const s = fresh();
  s.setTokens(tokens);
  s.put(btn);
  assert.deepEqual(s.get("btn"), btn);
  assert.deepEqual(s.list(), ["btn"]);
  assert.deepEqual(s.tokens(), tokens);
});

test("setParams updates base params or a variant", () => {
  const s = fresh();
  s.put(btn);
  s.setParams("btn", { stroke: 4 });
  assert.equal(s.get("btn").params[0].value, 4);
  s.setParams("btn", { stroke: 5 }, "thick");
  assert.equal(s.get("btn").variants.thick.stroke, 5);
  assert.throws(() => s.setParams("btn", { nope: 1 }), /unknown param "nope"/);
});

test("a malformed params.json names the file and the field", () => {
  const s = fresh();
  s.put(btn);
  writeFileSync(join(s.projectDir, "elements/btn/params.json"), JSON.stringify([{ name: "x", type: "colour", value: 1 }]));
  assert.throws(() => s.get("btn"), (e: unknown) =>
    e instanceof StudioError && e.code === "invalid_file" && /params\.json/.test(e.message) && /type/.test(e.message));
});

test("snapshot and restore bring an element back", () => {
  const s = fresh();
  s.put(btn);
  s.snapshot("first");
  s.setParams("btn", { stroke: 9 });
  s.restore("first");
  assert.equal(s.get("btn").params[0].value, 2);
  assert.ok(s.snapshots().includes("first"));
});

test("get of a missing element is a not_found error", () => {
  const s = fresh();
  mkdirSync(join(s.projectDir, "elements"), { recursive: true });
  assert.throws(() => s.get("ghost"), (e: unknown) => e instanceof StudioError && e.code === "not_found");
});
