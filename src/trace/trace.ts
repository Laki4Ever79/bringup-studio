import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import potrace from "potrace";
import { STUDIO_ROOT } from "../server/app.ts";
import { StudioError } from "../model/types.ts";
import { flatten, hasAlpha, palette, scoreTrace, type RGB } from "./score.ts";

export type TraceOpts = { mode: "color" | "mono"; gate?: number; maxIter?: number; palette?: Record<string, string> };
export type TraceResult = {
  svg: string; iou: number; edge: number; overlay: Buffer; passed: boolean; iterations: number; settings: Record<string, number>;
};

// ---- engines --------------------------------------------------------------------------------------------
const PY = `import sys, vtracer, json
a = json.loads(sys.argv[1])
sys.stdout.write(vtracer.convert_raw_image_to_svg(sys.stdin.buffer.read(), img_format="png", colormode="color",
  hierarchical="stacked", mode="spline", **a))`;

function vtracer(png: Buffer, s: Record<string, number>): Promise<string> {
  const py = join(STUDIO_ROOT, ".venv/bin/python");
  if (!existsSync(py)) throw new StudioError("no_tool", "vtracer missing: run scripts/setup-tools.sh");
  return new Promise((resolve, reject) => {
    const p = spawn(py, ["-I", "-c", PY, JSON.stringify(s)], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("close", (code) => code === 0 ? resolve(Buffer.concat(out).toString()) : reject(new Error(Buffer.concat(err).toString())));
    p.stdin.end(png);
  });
}

function potraceSvg(png: Buffer, s: Record<string, number>): Promise<string> {
  return new Promise((resolve, reject) =>
    (potrace as any).trace(png, { turdSize: s.turdSize, alphaMax: s.alphaMax, optTolerance: s.optTolerance, threshold: 128, color: "#000000", background: "transparent" },
      (err: Error | null, svg: string) => (err ? reject(err) : resolve(svg))));
}

// ---- colour helpers -------------------------------------------------------------------------------------
const hex = (c: RGB) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
const rgb = (h: string): RGB => {
  const s = h.replace("#", "");
  const f = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)) as RGB;
};
function lab([r, g, b]: RGB): RGB {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), y = f(R * 0.2126 + G * 0.7152 + B * 0.0722), z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a: string, b: string) => { const p = lab(rgb(a)), q = lab(rgb(b)); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

/** Snap a colour to the nearest palette colour when ΔE76 < 6; otherwise return it unchanged. */
export function snapColor(c: string, pal: Record<string, string>): string {
  let best = c, bd = 6;
  for (const v of Object.values(pal)) { const d = deltaE(c, v); if (d < bd) { bd = d; best = v; } }
  return best;
}

// ---- path geometry --------------------------------------------------------------------------------------
type Pt = [number, number];
/** Sample points along an absolute/relative M/L/H/V/C/Z path; returns subpaths. */
function samplePath(d: string, dx = 0, dy = 0): Pt[][] {
  const toks = d.match(/[MmLlHhVvCcZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  const subs: Pt[][] = [];
  let cur: Pt = [0, 0], start: Pt = [0, 0], cmd = "", i = 0, sub: Pt[] = [];
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === "Z") { if (sub.length) subs.push(sub); sub = []; cur = start; continue; }
    if (C === "M") { if (sub.length) subs.push(sub); const p: Pt = [num(), num()]; cur = rel ? [cur[0] + p[0], cur[1] + p[1]] : p; start = cur; sub = [cur]; cmd = rel ? "l" : "L"; continue; }
    if (C === "L") { const p: Pt = [num(), num()]; cur = rel ? [cur[0] + p[0], cur[1] + p[1]] : p; sub.push(cur); continue; }
    if (C === "H") { const x = num(); cur = [rel ? cur[0] + x : x, cur[1]]; sub.push(cur); continue; }
    if (C === "V") { const y = num(); cur = [cur[0], rel ? cur[1] + y : y]; sub.push(cur); continue; }
    if (C === "C") {
      const a = [num(), num(), num(), num(), num(), num()];
      const o = rel ? cur : [0, 0];
      const p1: Pt = [a[0] + o[0], a[1] + o[1]], p2: Pt = [a[2] + o[0], a[3] + o[1]], p3: Pt = [a[4] + o[0], a[5] + o[1]];
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const m = 1 - t;
        sub.push([m ** 3 * cur[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t ** 3 * p3[0],
          m ** 3 * cur[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t ** 3 * p3[1]]);
      }
      cur = p3; continue;
    }
    i++; // unknown token: skip
  }
  if (sub.length) subs.push(sub);
  return subs.map((s) => s.map(([x, y]) => [x + dx, y + dy] as Pt));
}

const area = (pts: Pt[]) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

function fitPrimitive(pts: Pt[], tol: number): string | null {
  if (pts.length < 6) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // rectangle: every point on the bounding box
  if (x1 - x0 > 2 && y1 - y0 > 2 && pts.every(([x, y]) => Math.min(Math.abs(x - x0), Math.abs(x - x1), Math.abs(y - y0), Math.abs(y - y1)) <= tol)) {
    return `<rect x="${+x0.toFixed(2)}" y="${+y0.toFixed(2)}" width="${+(x1 - x0).toFixed(2)}" height="${+(y1 - y0).toFixed(2)}"`;
  }
  // circle: equal radius around the bbox centre
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = ((x1 - x0) + (y1 - y0)) / 4;
  if (r > 2 && Math.abs((x1 - x0) - (y1 - y0)) <= 2 * tol && pts.every(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - r) <= tol)) {
    return `<circle cx="${+cx.toFixed(2)}" cy="${+cy.toFixed(2)}" r="${+r.toFixed(2)}"`;
  }
  return null;
}

type Shape = { tag: string; d?: string; fill: string; dx: number; dy: number; prim?: string };

function parseShapes(svg: string): { w: number; h: number; shapes: Shape[] } {
  const w = Number(svg.match(/<svg[^>]*\swidth="([\d.]+)/)?.[1] ?? 0), h = Number(svg.match(/<svg[^>]*\sheight="([\d.]+)/)?.[1] ?? 0);
  const shapes: Shape[] = [];
  for (const m of svg.matchAll(/<path\b([^>]*)\/?>/g)) {
    const a = m[1];
    const d = a.match(/\sd="([^"]*)"/)?.[1] ?? "";
    const fill = a.match(/\sfill="([^"]*)"/)?.[1] ?? "#000000";
    const tr = a.match(/translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/);
    shapes.push({ tag: "path", d, fill, dx: tr ? Number(tr[1]) : 0, dy: tr ? Number(tr[2]) : 0 });
  }
  return { w, h, shapes };
}

function writeSvg(w: number, h: number, shapes: Shape[]): string {
  const body = shapes.map((s) => s.prim
    ? `${s.prim} fill="${s.fill}"/>`
    : `<path d="${s.d}" fill="${s.fill}"${s.dx || s.dy ? ` transform="translate(${s.dx},${s.dy})"` : ""}/>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${body}\n</svg>\n`;
}

/** Cleanup: drop the key-coloured background, snap fills, drop specks, and swap paths for exact rects/circles. */
function cleanup(svg: string, o: { key?: string; palette?: Record<string, string>; tol: number }): string {
  const { w, h, shapes } = parseShapes(svg);
  if (!shapes.length) return svg; // potrace output etc.: leave as is
  const out: Shape[] = [];
  for (const s of shapes) {
    if (o.key && deltaE(s.fill, o.key) < 25) continue;
    const subs = samplePath(s.d ?? "", s.dx, s.dy);
    if (subs.reduce((a, p) => a + area(p), 0) < 2) continue;
    const fill = o.palette ? snapColor(s.fill, o.palette) : s.fill;
    const prim = subs.length === 1 ? fitPrimitive(subs[0], o.tol) : null;
    out.push({ ...s, fill, prim: prim ?? undefined });
  }
  return writeSvg(w, h, out);
}

// ---- search ---------------------------------------------------------------------------------------------
const SPACE = {
  color: {
    start: { color_precision: 6, filter_speckle: 4, corner_threshold: 60, path_precision: 3, layer_difference: 16 },
    step: { color_precision: 1, filter_speckle: 2, corner_threshold: 15, path_precision: 1, layer_difference: 0 },
    min: { color_precision: 1, filter_speckle: 0, corner_threshold: 0, path_precision: 1, layer_difference: 1 },
    max: { color_precision: 8, filter_speckle: 128, corner_threshold: 180, path_precision: 8, layer_difference: 255 },
  },
  mono: {
    start: { turdSize: 2, alphaMax: 1, optTolerance: 0.2 },
    step: { turdSize: 2, alphaMax: 0.25, optTolerance: 0.1 },
    min: { turdSize: 0, alphaMax: 0, optTolerance: 0 },
    max: { turdSize: 100, alphaMax: 1.34, optTolerance: 1 },
  },
} as const;

/** Pick a key colour for transparent pixels, as far as possible from every colour in the image. */
function keyColour(png: PNG): RGB {
  const pal = palette(flatten(png));
  const cands: RGB[] = [[255, 0, 255], [0, 255, 255], [255, 255, 0], [0, 255, 0], [255, 0, 0], [0, 0, 255]];
  let best = cands[0], bd = -1;
  for (const c of cands) {
    const d = Math.min(...pal.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
    if (d > bd) { bd = d; best = c; }
  }
  return best;
}

export async function trace(src: Buffer, o: TraceOpts): Promise<TraceResult> {
  const gate = o.gate ?? 0.98, maxIter = o.maxIter ?? 12;
  const png = PNG.sync.read(src);
  const alpha = hasAlpha(png);
  const key = alpha && o.mode === "color" ? keyColour(png) : undefined;
  const input = PNG.sync.write(flatten(png, key ?? [255, 255, 255]));
  const space = SPACE[o.mode];
  const tol = 1;

  let evals = 0;
  const run = async (s: Record<string, number>) => {
    evals++;
    const raw = o.mode === "color" ? await vtracer(input, s) : await potraceSvg(input, s);
    const svg = cleanup(raw, { key: key ? hex(key) : undefined, palette: o.palette, tol });
    const sc = await scoreTrace(src, svg);
    // Guard: if cleanup (primitives/snap) lost fidelity, fall back to the uncleaned trace.
    if (o.mode === "color" && sc.iou < gate) {
      const plain = cleanup(raw, { key: key ? hex(key) : undefined, tol: -1 });
      const sp = await scoreTrace(src, plain);
      if (sp.iou > sc.iou + 0.002) return { svg: plain, ...sp, settings: s };
    }
    return { svg, ...sc, settings: s };
  };

  let best = await run({ ...space.start });
  let stale = 0;
  for (let round = 0; round < maxIter && best.iou < gate && stale < 2; round++) {
    let improved = false;
    for (const k of Object.keys(space.step) as (keyof typeof space.step)[]) {
      const step = (space.step as Record<string, number>)[k];
      if (!step) continue;
      for (const dir of [-1, 1]) {
        const v = Math.min((space.max as Record<string, number>)[k], Math.max((space.min as Record<string, number>)[k], best.settings[k] + dir * step));
        if (v === best.settings[k]) continue;
        const r = await run({ ...best.settings, [k]: v });
        if (r.iou > best.iou + 1e-4) { best = r; improved = true; }
        if (best.iou >= gate) break;
      }
      if (best.iou >= gate) break;
    }
    stale = improved ? 0 : stale + 1;
  }
  return { svg: best.svg, iou: best.iou, edge: best.edge, overlay: best.overlay, passed: best.iou >= gate, iterations: evals, settings: best.settings };
}
