import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";
import gifenc from "gifenc";

const { GIFEncoder, quantize, applyPalette } = gifenc as unknown as {
  GIFEncoder: () => { writeFrame(idx: Uint8Array, w: number, h: number, o: object): void; finish(): void; bytes(): Uint8Array };
  quantize: (rgba: Uint8Array | Uint8ClampedArray, n: number) => number[][];
  applyPalette: (rgba: Uint8Array | Uint8ClampedArray, pal: number[][]) => Uint8Array;
};

export type RenderOpts = { width: number; height?: number; theme: "light" | "dark"; selector?: string; fullPage?: boolean; scale?: number };

let browser: Promise<Browser> | null = null;
function getBrowser() {
  browser ??= chromium.launch();
  return browser;
}

export async function closeRenderer() {
  if (browser) { const b = await browser; browser = null; await b.close(); }
}

async function open(url: string, o: RenderOpts): Promise<Page> {
  const b = await getBrowser();
  const page = await b.newPage({
    viewport: { width: o.width, height: o.height ?? 800 },
    deviceScaleFactor: o.scale ?? 1,
    colorScheme: o.theme,
  });
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), o.theme);
  await page.evaluate(() => document.fonts?.ready);
  return page;
}

async function shot(page: Page, o: RenderOpts): Promise<Buffer> {
  if (o.selector) {
    const el = await page.$(o.selector);
    if (!el) throw new Error(`selector not found: ${o.selector}`);
    return el.screenshot({ animations: "allow" });
  }
  return page.screenshot({ fullPage: o.fullPage ?? false, animations: "allow" });
}

/** Freeze every animation (CSS and WAAPI) at time t (ms). */
async function seek(page: Page, t: number) {
  await page.evaluate((t) => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = t; }
  }, t);
}

export async function renderPng(url: string, o: RenderOpts): Promise<Buffer> {
  const page = await open(url, o);
  try {
    if (!o.fullPage) await seek(page, 1e7); // settle entrance animations at their end state
    return await shot(page, o);
  } finally { await page.close(); }
}

/** Render one frame per time and lay them out as a horizontal strip. */
export async function renderFrames(url: string, o: RenderOpts & { times: number[] }): Promise<Buffer> {
  const page = await open(url, o);
  try {
    const frames: PNG[] = [];
    for (const t of o.times) {
      await seek(page, t);
      frames.push(PNG.sync.read(await shot(page, o)));
    }
    const w = frames[0].width, h = frames[0].height, gap = o.times.length > 1 && o.selector ? 4 : 0;
    const out = new PNG({ width: w * frames.length + gap * (frames.length - 1), height: h });
    out.data.fill(255);
    frames.forEach((f, i) => PNG.bitblt(f, out, 0, 0, Math.min(w, f.width), Math.min(h, f.height), i * (w + gap), 0));
    return PNG.sync.write(out);
  } finally { await page.close(); }
}

export async function renderGif(url: string, o: RenderOpts & { fps: number; duration: number }): Promise<Buffer> {
  const page = await open(url, o);
  try {
    const enc = GIFEncoder();
    const step = 1000 / o.fps;
    for (let t = 0; t <= o.duration + 1e-6; t += step) {
      await seek(page, t);
      const f = PNG.sync.read(await shot(page, o));
      const pal = quantize(f.data, 256);
      enc.writeFrame(applyPalette(f.data, pal), f.width, f.height, { palette: pal, delay: Math.round(step) });
    }
    enc.finish();
    return Buffer.from(enc.bytes());
  } finally { await page.close(); }
}
