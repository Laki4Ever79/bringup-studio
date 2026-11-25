import { StudioError, type ElementDef, type Param, type Strings, type Tokens } from "./types.ts";

const DARK_MEDIA = '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){';
const DARK_ATTR = ':root[data-theme="dark"]{';

/** Tokens → CSS custom properties, using the Bringup site's light/dark selector pattern. */
export function compileTokens(t: Tokens): string {
  const light: string[] = [];
  const dark: string[] = [];
  for (const [k, v] of Object.entries(t.color)) {
    light.push(`--${k}:${v.light}`);
    dark.push(`--${k}:${v.dark}`);
  }
  for (const group of [t.font, t.size, t.ease, t.dur]) for (const [k, v] of Object.entries(group)) light.push(`--${k}:${v}`);
  dark.push("color-scheme:dark");
  return `:root{${light.join(";")}}\n${DARK_MEDIA}${dark.join(";")}}}\n${DARK_ATTR}${dark.join(";")}}\n`;
}

function paramValue(p: Param, v: string | number): string {
  return typeof v === "number" && p.unit ? `${v}${p.unit}` : String(v);
}

/** Resolve an element's params with an optional variant applied. */
export function resolveParams(e: ElementDef, variant?: string): Record<string, string> {
  let over: Record<string, string | number> = {};
  if (variant) {
    if (!e.variants[variant]) throw new StudioError("not_found", `element "${e.id}" has no variant "${variant}"`);
    over = e.variants[variant];
  }
  const out: Record<string, string> = {};
  for (const p of e.params) out[p.name] = paramValue(p, over[p.name] ?? p.value);
  return out;
}

export const scopeOf = (e: Pick<ElementDef, "id" | "scope">) => e.scope ?? `[data-studio="${e.id}"]`;

function scope(root: string, selector: string): string {
  return selector === "&" ? root : selector.startsWith("&") ? root + selector.slice(1) : `${root} ${selector}`;
}

/** Tag the markup's first element with data-studio="<id>" (idempotent). */
export function tagMarkup(id: string, markup: string): string {
  if (/^\s*<[a-zA-Z][^>]*\sdata-studio="/.test(markup)) return markup;
  return markup.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9-]*)/, `$1 data-studio="${id}"`);
}

export function compileElement(e: ElementDef, variant?: string): { css: string; markup: string } {
  const vals = resolveParams(e, variant);
  const vars = Object.entries(vals).map(([k, v]) => `--${e.id}-${k}:${v}`).join(";");
  const root = scopeOf(e);
  const parts = [vars ? `${root}{${vars}}` : "", e.css.trim()];
  const bySelector = new Map<string, string[]>();
  e.motion.forEach((t, n) => {
    const name = `${e.id}-${n}`;
    const frames = [...t.keyframes].sort((a, b) => a.offset - b.offset)
      .map((k) => `${+(k.offset * 100).toFixed(3)}%{${t.property}:${k.value}${k.ease ? `;animation-timing-function:${k.ease}` : ""}}`)
      .join("");
    parts.push(`@keyframes ${name}{${frames}}`);
    const sel = scope(root, t.selector);
    const list = bySelector.get(sel) ?? [];
    list.push(`${name} ${t.duration} ${t.delay ?? "0s"} ${t.iterations ?? 1} both`);
    bySelector.set(sel, list);
  });
  for (const [sel, anims] of bySelector) parts.push(`${sel}{animation:${anims.join(",")}}`);
  return { css: parts.filter(Boolean).join("\n"), markup: tagMarkup(e.id, e.markup.trim()) };
}

/** A language code safe to place in markup ("en", "sr", "sr-Latn"); anything else falls back to "en". */
export const safeLang = (l: string | null | undefined) => (l && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l) ? l : "en");

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function applyStrings(markup: string, strings: Strings | undefined, lang: string): string {
  const table = strings?.[lang];
  if (!table) return markup;
  // Replace the text of simple elements carrying data-i18n (no nested tags inside).
  return markup.replace(/(<([a-zA-Z0-9-]+)[^>]*\sdata-i18n="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g,
    (m, open, _tag, key, _text, close) => (key in table ? open + esc(table[key]) + close : m));
}

export const DEFAULT_FONTS =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap";

/** Kinds that fill a page column; previewed on a stage as wide as the Bringup page's 720px column. */
export const WIDE_KINDS = new Set(["section", "illustration"]);
export const stageOpen = (kind: string, width = 720) =>
  WIDE_KINDS.has(kind) ? `<div class="studio-stage" style="width:min(100%,${width}px)">` : `<div class="studio-stage">`;

/** A standalone HTML document showing one element (one variant) on the project's paper. */
export function elementPage(p: {
  tokens: Tokens; el: ElementDef; variant?: string; theme: "light" | "dark"; lang?: string;
  strings?: Strings; fontsHref?: string; baseCss?: string; pad?: number;
}): string {
  const lang = safeLang(p.lang);
  const { css, markup } = compileElement(p.el, p.variant);
  return `<!doctype html><html lang="${lang}" data-theme="${p.theme}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${p.fontsHref ?? DEFAULT_FONTS}">
<style>${compileTokens(p.tokens)}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--paper);color:var(--ink);font:16px/1.6 var(--f-body, system-ui);display:grid;place-items:center;min-height:100vh;padding:${p.pad ?? 24}px}
${p.baseCss ?? ""}
${css}</style></head><body>${stageOpen(p.el.kind)}${applyStrings(markup, p.strings, lang)}</div></body></html>`;
}
