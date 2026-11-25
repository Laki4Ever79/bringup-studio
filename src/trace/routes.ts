import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { body, route } from "../server/app.ts";
import { StudioError } from "../model/types.ts";
import { trace } from "./trace.ts";

/**
 * POST /api/trace {path | ref, mode?, element?, kind?, gate?, snap?}
 * Traces a PNG (absolute path, or a file in the project's refs/), stores the source + overlay in refs/, and when
 * `element` is given saves the SVG as that element. `snap: true` snaps fills to the project's colour tokens.
 */
route("POST", /^\/api\/trace$/, async (req, _res, _m, ctx) => {
  const b = await body(req);
  const refs = join(ctx.projectDir, "refs");
  mkdirSync(refs, { recursive: true });
  const src = b.ref ? join(refs, basename(String(b.ref))) : String(b.path ?? "");
  if (!src || !isAbsolute(src) || !existsSync(src)) throw new StudioError("not_found", `no image at "${b.ref ?? b.path}" (give an absolute path or a ref name)`);
  if (b.element) ctx.lock.check(req.headers["x-studio-session"] as string | undefined);
  const tokens = ctx.store.tokens();
  const pal = b.snap ? Object.fromEntries(Object.entries(tokens.color).flatMap(([k, v]) => [[k, v.light], [k + "-dark", v.dark]])) : undefined;
  const r = await trace(readFileSync(src), { mode: b.mode === "mono" ? "mono" : "color", gate: b.gate, palette: pal });
  const stem = `trace-${Date.now()}`;
  writeFileSync(join(refs, `${stem}-overlay.png`), r.overlay);
  writeFileSync(join(refs, `${stem}.svg`), r.svg);
  if (b.element) {
    ctx.store.put({ id: String(b.element), kind: b.kind ?? "logo", markup: r.svg, css: "", params: [], motion: [], variants: {}, note: `traced from ${basename(src)}: iou ${r.iou.toFixed(4)}` });
    ctx.broadcast({ type: "reload", element: b.element });
  }
  ctx.broadcast({ type: "refs" });
  return { iou: r.iou, edge: r.edge, passed: r.passed, iterations: r.iterations, settings: r.settings, svg: r.svg, overlay: `${stem}-overlay.png`, overlayPath: join(refs, `${stem}-overlay.png`) };
});
