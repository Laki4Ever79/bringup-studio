import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { renderPng, closeRenderer } from "../src/render/render.ts";
import { scoreTrace } from "../src/trace/score.ts";
import { trace, snapColor } from "../src/trace/trace.ts";

after(() => closeRenderer());

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<rect x="28" y="150" width="200" height="60" fill="#0E5A4A"/><circle cx="128" cy="92" r="58" fill="#B3622A"/></svg>`;

async function raster(svg: string, bg: string) {
  const url = "data:text/html," + encodeURIComponent(
    `<html><body style="margin:0;background:${bg}">${svg}</body></html>`);
  return renderPng(url, { width: 256, height: 256, theme: "light" });
}

/** Make every white pixel transparent (a logo exported with no background). */
function knockOutWhite(buf: Buffer) {
  const p = PNG.sync.read(buf);
  for (let i = 0; i < p.data.length; i += 4) if (p.data[i] > 250 && p.data[i + 1] > 250 && p.data[i + 2] > 250) p.data[i + 3] = 0;
  return PNG.sync.write(p);
}

test("the source svg scores near-perfect against its own raster", async () => {
  const src = await raster(LOGO, "#fff");
  const s = await scoreTrace(src, LOGO);
  assert.ok(s.iou > 0.99, `iou ${s.iou}`);
  assert.ok(s.edge > 0.95, `edge ${s.edge}`);
  assert.equal(PNG.sync.read(s.overlay).width, 256);
});

test("a wrong trace scores low", async () => {
  const src = await raster(LOGO, "#fff");
  const s = await scoreTrace(src, LOGO.replace('r="58"', 'r="30"'));
  assert.ok(s.iou < 0.9, `iou ${s.iou}`);
});

test("a flat two-colour logo traces past the gate, with a true circle", async () => {
  const src = await raster(LOGO, "#fff");
  const r = await trace(src, { mode: "color" });
  assert.equal(r.passed, true, `iou ${r.iou}`);
  assert.ok(r.iou >= 0.98);
  assert.match(r.svg, /<circle/);
});

test("transparent pixels count as background, not black", async () => {
  const white = await raster(LOGO, "#fff");
  const clear = knockOutWhite(white);
  const a = await scoreTrace(white, LOGO);
  const b = await scoreTrace(clear, LOGO);
  assert.ok(Math.abs(a.iou - b.iou) < 0.005, `${a.iou} vs ${b.iou}`);
  const r = await trace(clear, { mode: "color" });
  assert.equal(r.passed, true, `iou ${r.iou}`);
  assert.doesNotMatch(r.svg, /fill="#(000000|000)"/i);
});

test("snapColor maps a near colour onto the palette token", () => {
  assert.equal(snapColor("#0F5B4B", { mask: "#0E5A4A", copper: "#B3622A" }), "#0E5A4A");
  assert.equal(snapColor("#123456", { mask: "#0E5A4A" }), "#123456");
});

test("mono mode traces black art with potrace", async () => {
  const src = await raster(LOGO.replaceAll(/fill="#[0-9A-F]+"/g, 'fill="#000"'), "#fff");
  const r = await trace(src, { mode: "mono" });
  assert.ok(r.iou >= 0.98, `iou ${r.iou}`);
});
