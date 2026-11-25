import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { body, route, type Ctx } from "../server/app.ts";
import { compileElement, compileTokens } from "../model/compile.ts";
import { StudioError, type ElementDef } from "../model/types.ts";
import { adopt, adoptedIds, applyInMemory, exportElement, importBack } from "./site.ts";

function sitePath(ctx: Ctx): string {
  const s = ctx.config().site;
  if (!s || !existsSync(s)) throw new StudioError("no_site", `project "${ctx.project}" has no site: set "site" (absolute path) in projects/${ctx.project}/project.json`);
  return s;
}
const statePath = (ctx: Ctx) => join(ctx.projectDir, "export-state.json");

/** What the studio would write for an id ("tokens" or an element), with an optional variant. */
function compiled(ctx: Ctx, id: string, variant?: string): { markup?: string; css?: string } {
  if (id === "tokens") return { css: compileTokens(ctx.store.tokens()) };
  const { css, markup } = compileElement(ctx.store.get(id), variant);
  return { css, markup };
}

/** POST /api/adopt {id, markup?: "<needle, e.g. class=\"robot\">", css: [selectors], kind?} → {diff, backup, created} */
route("POST", /^\/api\/adopt$/, async (req, _r, _m, ctx) => {
  const b = await body(req);
  const id = String(b.id ?? "");
  const r = adopt(sitePath(ctx), { id, markupNeedle: b.markup, cssSelectors: b.css ?? [] }, statePath(ctx));
  let created = false;
  if (id !== "tokens" && !ctx.store.list().includes(id)) {
    const got = importBack(sitePath(ctx), id);
    const el: ElementDef = {
      id, kind: b.kind ?? "section", markup: got.markup ?? "", css: got.css ?? "", params: [], motion: [], variants: {},
      note: "adopted from the page",
      ...(got.markup === undefined && b.css?.[0] ? { scope: String(b.css[0]) } : {}),
    };
    ctx.store.put(el);
    created = true;
    ctx.broadcast({ type: "reload", element: id });
  }
  return { ...r, created };
}, { write: true });

/** POST /api/export {id, variant?} — writes inside the markers; 409 hand_edited when the page was edited there. */
route("POST", /^\/api\/export$/, async (req, _r, _m, ctx) => {
  const b = await body(req);
  const id = String(b.id ?? "");
  const out = exportElement(sitePath(ctx), id, compiled(ctx, id, b.variant), statePath(ctx));
  ctx.broadcast({ type: "reload" });
  return out;
}, { write: true });

/** POST /api/import {id} — pull the page's current marker content back into the element (accepts a hand edit). */
route("POST", /^\/api\/import$/, async (req, _r, _m, ctx) => {
  const id = String((await body(req)).id ?? "");
  const got = importBack(sitePath(ctx), id, statePath(ctx));
  if (id !== "tokens") {
    const el = ctx.store.get(id);
    if (got.markup !== undefined) el.markup = got.markup.replace(new RegExp(` data-studio="${id}"`), "");
    if (got.css !== undefined) el.css = got.css;
    ctx.store.put(el);
    ctx.broadcast({ type: "reload", element: id });
  }
  return got;
}, { write: true });

/** The real page with every adopted element's current studio version spliced in (nothing is written). */
route("GET", /^\/preview\/page$/, (_req, res, _m, ctx, q) => {
  const html = readFileSync(sitePath(ctx), "utf8");
  const ids = adoptedIds(html);
  const known = new Set(ctx.store.list());
  const exports = Object.fromEntries(ids.filter((id) => id === "tokens" || known.has(id)).map((id) => [id, compiled(ctx, id)]));
  const theme = q.get("theme") === "dark" ? "dark" : "light";
  const lang = q.get("lang") === "sr" ? "sr" : "en";
  const head = `<script>try{localStorage.setItem("bringup-lang",${JSON.stringify(lang)})}catch(e){}document.documentElement.setAttribute("data-theme",${JSON.stringify(theme)})</script>`;
  const out = applyInMemory(html, exports).replace(/<head>/i, `<head>${head}`);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(out);
}, { raw: true });
