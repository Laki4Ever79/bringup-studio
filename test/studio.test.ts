import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startServer } from "../src/server/app.ts";
import "../src/server/routes.ts";
import { btn, tokens } from "./fixtures.ts";

const srv = await startServer({ root: mkdtempSync(join(tmpdir(), "studio-ui-")), port: 0, project: "demo", watch: false });
srv.ctx.store.setTokens(tokens);
srv.ctx.store.put(btn);
srv.ctx.store.put({ ...btn, id: "logo", kind: "logo", variants: { a: { stroke: 1 }, b: { stroke: 5 } } });
const browser = await chromium.launch();
after(async () => { await browser.close(); await srv.close(); });

test("show switches the board to an element; Pick posts feedback; status shows", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(srv.url + "/");
  await page.waitForSelector("#conn[data-state=open]");
  await fetch(srv.url + "/api/show", { method: "POST", body: JSON.stringify({ view: "board", element: "logo", note: "two weights" }) });
  await page.waitForSelector('.tile[data-variant="b"]');
  assert.match(await page.textContent("#note") ?? "", /two weights/);
  await page.click('.tile[data-variant="b"] .hit');
  await page.click("#pick");
  const fb = await (await fetch(srv.url + "/api/feedback?since=0")).json();
  assert.equal(fb.items.at(-1).kind, "pick");
  assert.equal(fb.items.at(-1).element, "logo");
  assert.equal(fb.items.at(-1).variant, "b");
  await fetch(srv.url + "/api/status", { method: "POST", body: JSON.stringify({ session: "claude-x", text: "tuning stroke" }) });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("tuning stroke"));
  assert.deepEqual(errors, []);
});

test("alt-click drops a pinned comment with tile coordinates", async () => {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(srv.url + "/#board/btn");
  await page.waitForSelector('.tile[data-variant="thick"] .hit');
  const box = (await page.$('.tile[data-variant="thick"] .hit'))!;
  await box.click({ modifiers: ["Alt"], position: { x: 30, y: 20 } });
  await page.fill("#comment-text", "thinner here");
  await page.click("#comment-send");
  await page.waitForFunction(() => document.querySelectorAll(".pin").length > 0);
  const fb = await (await fetch(srv.url + "/api/feedback?since=0")).json();
  const c = fb.items.at(-1);
  assert.equal(c.kind, "comment");
  assert.equal(c.variant, "thick");
  assert.equal(c.x, 30);
  assert.equal(c.y, 20);
  assert.equal(c.text, "thinner here");
});
