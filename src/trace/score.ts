import { PNG } from "pngjs";
import { renderPng } from "../render/render.ts";

export type RGB = [number, number, number];

/** Flatten alpha onto a background colour (alpha < 128 counts as background, partial alpha is blended). */
export function flatten(png: PNG, bg: RGB = [255, 255, 255]): PNG {
  const out = new PNG({ width: png.width, height: png.height });
  for (let i = 0; i < png.data.length; i += 4) {
    const a = png.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(png.data[i + c] * a + bg[c] * (1 - a));
    out.data[i + 3] = 255;
  }
  return out;
}

export function hasAlpha(png: PNG): boolean {
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] < 250) return true;
  return false;
}

/** The flat palette of an image: exact colours covering at least `minShare` of pixels (anti-alias blends drop out). */
export function palette(png: PNG, minShare = 0.002): RGB[] {
  const counts = new Map<number, number>();
  for (let i = 0; i < png.data.length; i += 4) {
    const k = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const total = png.width * png.height;
  const cols = [...counts].filter(([, n]) => n / total >= minShare).sort((a, b) => b[1] - a[1]).map(([k]) => [k >> 16, (k >> 8) & 255, k & 255] as RGB);
  return cols.length ? cols.slice(0, 32) : [[255, 255, 255]];
}

function labels(png: PNG, pal: RGB[]): Uint8Array {
  const out = new Uint8Array(png.width * png.height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < pal.length; k++) {
      const dr = png.data[i] - pal[k][0], dg = png.data[i + 1] - pal[k][1], db = png.data[i + 2] - pal[k][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = k; }
    }
    out[p] = best;
  }
  return out;
}

function edges(l: Uint8Array, w: number, h: number): Uint8Array {
  const e = new Uint8Array(l.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if ((x + 1 < w && l[p] !== l[p + 1]) || (y + 1 < h && l[p] !== l[p + w])) e[p] = 1;
  }
  return e;
}

export async function rasterizeSvg(svg: string, width: number, height: number, bg = "#fff"): Promise<PNG> {
  const sized = svg.replace(/<svg\b([^>]*)>/, (_m, attrs: string) =>
    `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, "")} width="${width}" height="${height}">`);
  const url = "data:text/html," + encodeURIComponent(
    `<html><body style="margin:0;background:${bg}"><div style="width:${width}px;height:${height}px;line-height:0">${sized}</div></body></html>`);
  return PNG.sync.read(await renderPng(url, { width, height, theme: "light" }));
}

/**
 * Compare a raster source with an SVG trace at the source size.
 * iou: mean IoU over the source's flat colours, weighted by each colour's union area.
 * edge: share of source edge pixels that have a trace edge within 1 px.
 * overlay: source in grey; red = trace misses source ink, blue = trace paints where source is background/other colour.
 */
export async function scoreTrace(src: Buffer, svg: string): Promise<{ iou: number; edge: number; overlay: Buffer }> {
  const s = flatten(PNG.sync.read(src));
  const t = await rasterizeSvg(svg, s.width, s.height);
  const pal = palette(s);
  const ls = labels(s, pal), lt = labels(t, pal);
  const inter = new Float64Array(pal.length), union = new Float64Array(pal.length);
  for (let p = 0; p < ls.length; p++) {
    if (ls[p] === lt[p]) { inter[ls[p]]++; union[ls[p]]++; }
    else { union[ls[p]]++; union[lt[p]]++; }
  }
  let num = 0, den = 0;
  for (let k = 0; k < pal.length; k++) if (union[k]) { num += (inter[k] / union[k]) * union[k]; den += union[k]; }
  const iou = den ? num / den : 1;

  const w = s.width, h = s.height;
  const es = edges(ls, w, h), et = edges(lt, w, h);
  let total = 0, hit = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!es[p]) continue;
    total++;
    search: for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && et[yy * w + xx]) { hit++; break search; }
    }
  }
  const edge = total ? hit / total : 1;

  const ov = new PNG({ width: w, height: h });
  const bgLabel = 0; // most common colour = background for flat art
  for (let p = 0, i = 0; p < ls.length; p++, i += 4) {
    const g = Math.round((s.data[i] * 0.3 + s.data[i + 1] * 0.59 + s.data[i + 2] * 0.11) * 0.35 + 150);
    let c: RGB = [g, g, g];
    if (ls[p] !== lt[p]) c = ls[p] !== bgLabel ? [220, 30, 30] : [30, 80, 230];
    ov.data[i] = c[0]; ov.data[i + 1] = c[1]; ov.data[i + 2] = c[2]; ov.data[i + 3] = 255;
  }
  return { iou, edge, overlay: PNG.sync.write(ov) };
}
