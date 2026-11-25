import { test, after } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { renderPng, renderFrames, renderGif, closeRenderer } from "../src/render/render.ts";

after(() => closeRenderer());

const page = (extra = "") => "data:text/html," + encodeURIComponent(`<!doctype html><html><head><style>
:root{--paper:#F6F7F4}:root[data-theme="dark"]{--paper:#0F1613}
html,body{margin:0;background:var(--paper)}
#b{width:40px;height:40px;margin:30px;background:#000}${extra}</style></head><body><div id="b"></div></body></html>`);

const px = (buf: Buffer, x: number, y: number) => {
  const p = PNG.sync.read(buf);
  const i = (p.width * y + x) * 4;
  return [p.data[i], p.data[i + 1], p.data[i + 2]];
};

test("renderPng respects width and theme", async () => {
  const light = await renderPng(page(), { width: 200, height: 120, theme: "light" });
  assert.equal(PNG.sync.read(light).width, 200);
  assert.deepEqual(px(light, 2, 2), [0xf6, 0xf7, 0xf4]);
  const dark = await renderPng(page(), { width: 200, height: 120, theme: "dark" });
  assert.deepEqual(px(dark, 2, 2), [0x0f, 0x16, 0x13]);
});

test("renderPng can clip to a selector", async () => {
  const el = await renderPng(page(), { width: 200, height: 120, theme: "light", selector: "#b" });
  assert.equal(PNG.sync.read(el).width, 40);
});

test("renderFrames samples an animation at given times", async () => {
  const anim = "@keyframes f{from{opacity:0}to{opacity:1}}#b{animation:f 1s linear both}";
  const strip = await renderFrames(page(anim), { width: 100, height: 100, theme: "light", times: [0, 1000] });
  const p = PNG.sync.read(strip);
  assert.equal(p.width, 200);
  const first = px(strip, 50, 50), last = px(strip, 150, 50);
  assert.notDeepEqual(first, last);
  assert.deepEqual(last, [0, 0, 0]);
});

test("renderGif produces a GIF", async () => {
  const gif = await renderGif(page("#b{animation:f 1s}@keyframes f{to{opacity:0}}"), { width: 80, height: 80, theme: "light", fps: 5, duration: 400 });
  assert.equal(gif.subarray(0, 6).toString(), "GIF89a");
});
