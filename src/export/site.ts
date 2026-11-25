import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { StudioError } from "../model/types.ts";

// Markers. HTML: <!-- studio:<id> -->…<!-- /studio:<id> -->. CSS: /* studio:<id> */…/* /studio:<id> */
const H_OPEN = (id: string) => `<!-- studio:${id} -->`;
const H_CLOSE = (id: string) => `<!-- /studio:${id} -->`;
const C_OPEN = (id: string) => `/* studio:${id} */`;
const C_CLOSE = (id: string) => `/* /studio:${id} */`;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

type Parts = { markup?: string; css?: string };
type State = Record<string, { markup?: string; css?: string }>;

const readState = (p: string): State => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
const writeState = (p: string, s: State) => writeFileSync(p, JSON.stringify(s, null, 2) + "\n");

function between(text: string, open: string, close: string): { start: number; end: number } | null {
  const a = text.indexOf(open);
  if (a < 0) return null;
  const b = text.indexOf(close, a + open.length);
  if (b < 0) throw new StudioError("bad_marker", `marker "${open}" has no closing "${close}"`);
  return { start: a + open.length, end: b };
}

/** Read what sits inside an element's markers (markup and/or css). */
export function inside(html: string, id: string): Parts {
  const out: Parts = {};
  const h = between(html, H_OPEN(id), H_CLOSE(id));
  if (h) out.markup = html.slice(h.start, h.end);
  const c = between(html, C_OPEN(id), C_CLOSE(id));
  if (c) out.css = html.slice(c.start, c.end);
  return out;
}

const cssInner = (css: string) => `\n${css.trim()}\n`;

function splice(html: string, id: string, p: Parts): string {
  let out = html;
  if (p.markup !== undefined) {
    const h = between(out, H_OPEN(id), H_CLOSE(id));
    if (h) out = out.slice(0, h.start) + p.markup.trim() + out.slice(h.end);
  }
  if (p.css !== undefined) {
    const c = between(out, C_OPEN(id), C_CLOSE(id));
    if (c) out = out.slice(0, c.start) + cssInner(p.css) + out.slice(c.end);
  }
  return out;
}

// ---- minimal CSS rule scanner (top level of one stylesheet) ---------------------------------------------
type Rule = { start: number; end: number; prelude: string; body: string };

function scanRules(css: string): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i++;
    if (css.startsWith("/*", i)) { const e = css.indexOf("*/", i + 2); i = e < 0 ? css.length : e + 2; continue; }
    if (i >= css.length) break;
    const start = i;
    let depth = 0, open = -1;
    for (; i < css.length; i++) {
      const ch = css[i];
      if (ch === "/" && css[i + 1] === "*") { const e = css.indexOf("*/", i + 2); i = e < 0 ? css.length : e + 1; continue; }
      if (ch === '"' || ch === "'") { const e = css.indexOf(ch, i + 1); i = e < 0 ? css.length : e; continue; }
      if (ch === "{") { if (depth === 0) open = i; depth++; }
      else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
      else if (ch === ";" && depth === 0) { i++; break; } // @import etc.
    }
    const prelude = (open < 0 ? css.slice(start, i) : css.slice(start, open)).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    rules.push({ start, end: i, prelude, body: open < 0 ? "" : css.slice(open + 1, i - 1) });
  }
  return rules;
}

function selectorMatches(sel: string, pats: string[]): boolean {
  return pats.some((p) => sel === p || (sel.startsWith(p) && !/[-_a-zA-Z0-9]/.test(sel[p.length])));
}

function ruleMatches(r: Rule, pats: string[]): boolean {
  if (r.prelude.startsWith("@")) {
    if (pats.some((p) => p.startsWith("@") && r.prelude.startsWith(p))) return true;
    const inner = scanRules(r.body);
    const sel = pats.filter((p) => !p.startsWith("@"));
    return inner.length > 0 && sel.length > 0 && inner.every((x) => ruleMatches(x, sel));
  }
  const sels = r.prelude.split(",").map((s) => s.trim()).filter(Boolean);
  return sels.length > 0 && sels.every((s) => selectorMatches(s, pats));
}

// ---- markup finder --------------------------------------------------------------------------------------
function findElement(html: string, needle: string): { start: number; end: number } {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*${esc}[^>]*>`).exec(html);
  if (!m) throw new StudioError("not_found", `no element with ${needle} in the page`);
  const tag = m[1].toLowerCase();
  const start = m.index;
  if (m[0].endsWith("/>")) return { start, end: start + m[0].length };
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, "gi");
  re.lastIndex = start + m[0].length;
  let depth = 1, x: RegExpExecArray | null;
  while ((x = re.exec(html))) {
    if (x[1]) depth--; else if (!x[2]) depth++;
    if (depth === 0) return { start, end: x.index + x[0].length };
  }
  throw new StudioError("bad_marker", `<${tag}> with ${needle} is not closed`);
}

function unifiedDiff(a: string, b: string, label: string): string {
  const r = spawnSync("diff", ["-u", "--label", `${label} (before)`, "--label", `${label} (after)`, a, b], { encoding: "utf8" });
  return r.stdout ?? "";
}

/**
 * One-time adopt: wrap an element's markup in place, and gather its CSS rules (every selector of the rule must
 * belong to the element) into a marked block at the position of the first one. Writes a backup first and returns
 * a unified diff. Records the wrapped content's hashes as the export baseline.
 */
export function adopt(sitePath: string, o: { id: string; markupNeedle?: string; cssSelectors: string[] }, statePath: string): { diff: string; backup: string } {
  if (!/^[a-z][a-z0-9-]*$/.test(o.id)) throw new StudioError("bad_id", `invalid element id "${o.id.slice(0, 40)}"`);
  let html = readFileSync(sitePath, "utf8");
  if (html.includes(C_OPEN(o.id)) || html.includes(H_OPEN(o.id))) throw new StudioError("bad_marker", `"${o.id}" is already adopted`);
  const backup = `${sitePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(sitePath, backup);

  if (o.markupNeedle) {
    const { start, end } = findElement(html, o.markupNeedle);
    html = html.slice(0, start) + H_OPEN(o.id) + html.slice(start, end) + H_CLOSE(o.id) + html.slice(end);
  }
  if (o.cssSelectors.length) {
    const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
    let done = false, m: RegExpExecArray | null;
    while (!done && (m = styleRe.exec(html))) {
      const cssStart = m.index + m[0].indexOf(">") + 1;
      const css = m[1];
      const hits = scanRules(css).filter((r) => ruleMatches(r, o.cssSelectors));
      if (!hits.length) continue;
      const moved = hits.map((r) => css.slice(r.start, r.end)).join("\n");
      let out = "", pos = 0;
      hits.forEach((r, k) => {
        out += css.slice(pos, r.start);
        if (k === 0) out += `${C_OPEN(o.id)}${cssInner(moved)}${C_CLOSE(o.id)}`;
        pos = r.end;
        if (k > 0 && css[pos] === "\n" && out.endsWith("\n")) pos++; // don't leave blank lines where rules left
      });
      out += css.slice(pos);
      html = html.slice(0, cssStart) + out + html.slice(cssStart + css.length);
      done = true;
    }
    if (!done) throw new StudioError("not_found", `no CSS rules match ${o.cssSelectors.join(", ")}`);
  }
  writeFileSync(sitePath, html);
  const st = readState(statePath);
  const now = inside(html, o.id);
  st[o.id] = { ...(now.markup !== undefined ? { markup: hash(now.markup) } : {}), ...(now.css !== undefined ? { css: hash(now.css) } : {}) };
  writeState(statePath, st);
  return { diff: unifiedDiff(backup, sitePath, "index.html"), backup };
}

/** Replace the content inside an element's markers. Refuses when that content was edited by hand since the last write. */
export function exportElement(sitePath: string, id: string, p: Parts, statePath: string): { wrote: ("markup" | "css")[] } {
  const html = readFileSync(sitePath, "utf8");
  const cur = inside(html, id);
  if (cur.markup === undefined && cur.css === undefined) throw new StudioError("not_adopted", `"${id}" has no studio markers in the page yet; adopt it first`);
  const st = readState(statePath);
  const base = st[id];
  for (const part of ["markup", "css"] as const) {
    if (cur[part] === undefined) continue;
    if (!base || base[part] !== hash(cur[part]!)) {
      throw new StudioError("hand_edited", `the ${part} of "${id}" was edited in the page since the studio last wrote it; import it back or discard the edit`, { id, part, current: cur[part] });
    }
  }
  const next: Parts = {};
  const wrote: ("markup" | "css")[] = [];
  if (cur.markup !== undefined && p.markup !== undefined) { next.markup = p.markup; wrote.push("markup"); }
  if (cur.css !== undefined && p.css !== undefined) { next.css = p.css; wrote.push("css"); }
  const out = splice(html, id, next);
  writeFileSync(sitePath, out);
  const now = inside(out, id);
  st[id] = { ...(now.markup !== undefined ? { markup: hash(now.markup) } : {}), ...(now.css !== undefined ? { css: hash(now.css) } : {}) };
  writeState(statePath, st);
  return { wrote };
}

/** What's inside the markers now (to pull a hand edit back into the studio). Also resets the baseline. */
export function importBack(sitePath: string, id: string, statePath?: string): Parts {
  const cur = inside(readFileSync(sitePath, "utf8"), id);
  if (cur.markup === undefined && cur.css === undefined) throw new StudioError("not_adopted", `"${id}" has no studio markers in the page`);
  if (statePath) {
    const st = readState(statePath);
    st[id] = { ...(cur.markup !== undefined ? { markup: hash(cur.markup) } : {}), ...(cur.css !== undefined ? { css: hash(cur.css) } : {}) };
    writeState(statePath, st);
  }
  return { ...(cur.markup !== undefined ? { markup: cur.markup.trim() } : {}), ...(cur.css !== undefined ? { css: cur.css.trim() } : {}) };
}

/** Splice exports into page HTML in memory (for the page preview). Unknown ids are ignored. */
export function applyInMemory(html: string, exports: Record<string, Parts>): string {
  let out = html;
  for (const [id, p] of Object.entries(exports)) out = splice(out, id, p);
  return out;
}

/** Ids that have markers in the page. */
export function adoptedIds(html: string): string[] {
  return [...new Set([...html.matchAll(/(?:<!--|\/\*) studio:([a-z][a-z0-9-]*) (?:-->|\*\/)/g)].map((m) => m[1]))];
}
