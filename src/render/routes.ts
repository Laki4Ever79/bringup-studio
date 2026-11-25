import { route, type Ctx } from "../server/app.ts";
import { compileElement, compileTokens, applyStrings, DEFAULT_FONTS, stageOpen, WIDE_KINDS, safeLang } from "../model/compile.ts";
import { StudioError } from "../model/types.ts";
import { renderFrames, renderGif, renderPng } from "./render.ts";

/** One self-contained page with every variant of an element as a labelled tile (optionally both themes). */
export function boardPage(ctx: Ctx, id: string, o: { variants?: string[]; themes: ("light" | "dark")[]; lang: string; tile?: number }) {
  const el = ctx.store.get(id);
  const cfg = ctx.config();
  const all = ["base", ...Object.keys(el.variants)];
  for (const v of o.variants ?? []) if (!all.includes(v)) throw new StudioError("not_found", `element "${id}" has no such variant (have: ${all.join(", ")})`);
  const names = o.variants?.length ? o.variants : all;
  o = { ...o, lang: safeLang(o.lang) };
  const strings = ctx.store.strings();
  const tiles: string[] = [];
  const css: string[] = [];
  names.forEach((v, i) => {
    const variant = v === "base" ? undefined : v;
    const scopedId = `${id}--${i}`;
    // Compile each variant under its own scoped id so tiles don't share custom properties.
    const c = compileElement({ ...el, id: scopedId, scope: undefined, css: el.css.replaceAll(`--${id}-`, `--${scopedId}-`) }, variant);
    css.push(c.css);
    for (const theme of o.themes) {
      tiles.push(`<figure class="tile" data-theme="${theme}" data-variant="${v}"><div class="stage">${stageOpen(el.kind, o.tile ? o.tile * 2 : 520)}${applyStrings(c.markup.replace(`data-studio="${scopedId}"`, `data-studio="${scopedId}" data-studio-el="${id}"`), strings, o.lang)}</div></div><figcaption>${v}${o.themes.length > 1 ? " · " + theme : ""}</figcaption></figure>`);
    }
  });
  const tok = compileTokens(ctx.store.tokens()).replace(/:root\[data-theme="dark"\]/, '[data-theme="dark"]');
  return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><link rel="stylesheet" href="${cfg.fontsHref ?? DEFAULT_FONTS}">
<style>${tok}
*,*::before,*::after{box-sizing:border-box}body{margin:0;padding:16px;background:#888;font:13px/1.4 "IBM Plex Mono",monospace}
.grid{display:flex;flex-wrap:wrap;gap:12px}
.tile{margin:0;background:var(--paper);color:var(--ink);border-radius:8px;overflow:hidden;min-width:${WIDE_KINDS.has(el.kind) ? 560 : o.tile ?? 220}px}
.stage{padding:28px;display:grid;place-items:center;min-height:${Math.round((o.tile ?? 220) * 0.6)}px}
figcaption{padding:6px 10px;color:var(--muted);border-top:1px solid var(--line)}
${cfg.baseCss ?? ""}
${css.join("\n")}</style></head><body><div class="grid">${tiles.join("")}</div></body></html>`;
}

route("GET", /^\/preview\/board\/([a-z][a-z0-9-]*)$/, (_req, res, m, ctx, q) => {
  const themes = (q.get("theme") ?? "light") === "both" ? ["light", "dark"] as const : [q.get("theme") === "dark" ? "dark" : "light"] as const;
  const html = boardPage(ctx, m[1], {
    variants: q.get("variants")?.split(",").filter(Boolean), themes: [...themes], lang: q.get("lang") ?? "en",
    tile: q.has("tile") ? Number(q.get("tile")) : undefined,
  });
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}, { raw: true });

/**
 * GET /api/render?target=element|board|page&id=&variant=&theme=&lang=&width=&height=&frames=0,250,500&gif=1&fps=&duration=&scale=
 * Returns image/png or image/gif.
 */
route("GET", /^\/api\/render$/, async (_req, res, _m, ctx, q) => {
  const target = q.get("target") ?? "element";
  const id = q.get("id") ?? "";
  const theme = q.get("theme") === "dark" ? "dark" : "light";
  const lang = q.get("lang") ?? "en";
  const p = new URLSearchParams({ theme, lang });
  let path: string;
  let selector: string | undefined;
  if (target === "element") {
    if (q.get("variant")) p.set("variant", q.get("variant")!);
    path = `/preview/element/${id}`;
    selector = q.get("clip") === "0" ? undefined : `[data-studio="${id}"]`;
  } else if (target === "board") {
    p.set("theme", q.get("theme") ?? "light");
    if (q.get("variants")) p.set("variants", q.get("variants")!);
    path = `/preview/board/${id}`;
  } else if (target === "page") {
    path = `/preview/page`;
  } else throw new StudioError("bad_param", `unknown target "${target}"`);
  if (target !== "page") ctx.store.get(id); // 404 early for a missing element
  const url = `${ctx.url}${path}?${p}`;
  const width = Number(q.get("width") ?? (target === "page" ? 1280 : target === "board" ? 1100 : 600));
  const height = q.has("height") ? Number(q.get("height")) : target === "element" ? 400 : 800;
  const o = { width, height, theme, selector, scale: Number(q.get("scale") ?? 1), fullPage: target !== "element" && q.get("full") !== "0" } as const;
  let buf: Buffer, type = "image/png";
  if (q.get("gif") === "1") {
    buf = await renderGif(url, { ...o, fullPage: false, fps: Number(q.get("fps") ?? 12), duration: Number(q.get("duration") ?? 1000) });
    type = "image/gif";
  } else if (q.get("frames")) {
    buf = await renderFrames(url, { ...o, fullPage: false, times: q.get("frames")!.split(",").map(Number) });
  } else buf = await renderPng(url, o);
  res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  res.end(buf);
}, { raw: true });
