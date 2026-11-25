import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { startServer } from "../src/server/app.ts";
import "../src/server/routes.ts";
import { closeRenderer } from "../src/render/render.ts";
import { btn, tokens } from "./fixtures.ts";

const srv = await startServer({ root: mkdtempSync(join(tmpdir(), "studio-rapi-")), port: 0, project: "demo", watch: false });
srv.ctx.store.setTokens(tokens);
srv.ctx.store.put(btn);
after(async () => { await closeRenderer(); await srv.close(); });

test("board preview has one tile per variant and theme", async () => {
  const html = await (await fetch(srv.url + "/preview/board/btn?theme=both")).text();
  assert.equal((html.match(/class="tile"/g) ?? []).length, 4);
  assert.match(html, /data-variant="thick"/);
});

test("render API returns a PNG of the element clipped to it", async () => {
  const r = await fetch(srv.url + "/api/render?target=element&id=btn&theme=dark");
  assert.equal(r.headers.get("content-type"), "image/png");
  const png = PNG.sync.read(Buffer.from(await r.arrayBuffer()));
  assert.ok(png.width < 600);
});

test("render API 404s for a missing element", async () => {
  assert.equal((await fetch(srv.url + "/api/render?target=element&id=ghost")).status, 404);
});

test("board preview never reflects query values as markup", async () => {
  const evil = encodeURIComponent('"><script>alert(1)</script>');
  const html = await (await fetch(srv.url + `/preview/board/btn?lang=${evil}&variants=${evil}`)).text();
  assert.doesNotMatch(html, /<script>alert/);
});

test("board tiles keep their own param values when the element's CSS uses plain class rules", async () => {
  srv.ctx.store.put({
    id: "dots", kind: "icon", note: "",
    markup: `<svg viewBox="0 0 10 10" width="40" height="40"><circle class="dot" cx="5" cy="5" r="4"/></svg>`,
    css: `.dot{fill:var(--dots-fill)}`,
    params: [{ name: "fill", type: "color", value: "#ff0000" }],
    motion: [], variants: { green: { fill: "#00ff00" }, blue: { fill: "#0000ff" } },
  } as any);
  const { chromium } = await import("playwright");
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    await p.goto(srv.url + "/preview/board/dots?variants=base,green,blue&theme=light");
    const fills = await p.$$eval(".tile .dot", (els) => els.map((e) => getComputedStyle(e).fill));
    assert.deepEqual(fills, ["rgb(255, 0, 0)", "rgb(0, 255, 0)", "rgb(0, 0, 255)"]);
  } finally { await b.close(); }
});
