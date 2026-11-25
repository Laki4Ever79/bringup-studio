import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ElementSchema, MetaSchema, MotionSchema, ParamsSchema, StudioError, TokensSchema, VariantSchema, parseFile,
  type ElementDef, type Strings, type Tokens,
} from "./types.ts";

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new StudioError("invalid_file", `${label}: ${(e as Error).message}`, { file: label });
  }
}

/**
 * File-based project store. Layout under projectDir:
 *   tokens.json, strings.json, elements/<id>/{meta.json, element.svg|element.html, style.css, params.json,
 *   motion.json, variants/<vid>.json}. History lives in a separate git dir (.history) so it never mixes with the
 *   studio's own repo.
 */
export class Store {
  constructor(public readonly projectDir: string) {
    mkdirSync(join(projectDir, "elements"), { recursive: true });
  }

  private elDir(id: string) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new StudioError("bad_id", `invalid element id "${id}"`);
    return join(this.projectDir, "elements", id);
  }

  tokens(): Tokens {
    const p = join(this.projectDir, "tokens.json");
    if (!existsSync(p)) return { color: {}, font: {}, size: {}, ease: {}, dur: {} };
    return parseFile(TokensSchema, readJson(p, "tokens.json"), "tokens.json");
  }

  setTokens(t: Tokens): void {
    const v = parseFile(TokensSchema, t, "tokens");
    writeFileSync(join(this.projectDir, "tokens.json"), JSON.stringify(v, null, 2) + "\n");
    this.commit("tokens");
  }

  strings(): Strings {
    const p = join(this.projectDir, "strings.json");
    return existsSync(p) ? (readJson(p, "strings.json") as Strings) : {};
  }

  list(): string[] {
    return readdirSync(join(this.projectDir, "elements"), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  }

  get(id: string): ElementDef {
    const dir = this.elDir(id);
    if (!existsSync(join(dir, "meta.json"))) throw new StudioError("not_found", `no element "${id}"`);
    const rel = (f: string) => `elements/${id}/${f}`;
    const meta = parseFile(MetaSchema, readJson(join(dir, "meta.json"), rel("meta.json")), rel("meta.json"));
    const markupFile = ["element.svg", "element.html"].find((f) => existsSync(join(dir, f)));
    const markup = markupFile ? readFileSync(join(dir, markupFile), "utf8") : "";
    const css = existsSync(join(dir, "style.css")) ? readFileSync(join(dir, "style.css"), "utf8") : "";
    const params = existsSync(join(dir, "params.json"))
      ? parseFile(ParamsSchema, readJson(join(dir, "params.json"), rel("params.json")), rel("params.json")) : [];
    const motion = existsSync(join(dir, "motion.json"))
      ? parseFile(MotionSchema, readJson(join(dir, "motion.json"), rel("motion.json")), rel("motion.json")) : [];
    const variants: ElementDef["variants"] = {};
    const vdir = join(dir, "variants");
    if (existsSync(vdir)) {
      for (const f of readdirSync(vdir).filter((f) => f.endsWith(".json")).sort()) {
        variants[f.slice(0, -5)] = parseFile(VariantSchema, readJson(join(vdir, f), rel(`variants/${f}`)), rel(`variants/${f}`));
      }
    }
    const el: ElementDef = { id, kind: meta.kind, markup, css, params, motion, variants };
    if (meta.note) el.note = meta.note;
    return el;
  }

  put(input: ElementDef): void {
    const e = parseFile(ElementSchema, input, `element ${input?.id}`) as ElementDef;
    const dir = this.elDir(e.id);
    mkdirSync(dir, { recursive: true });
    const isSvg = /^\s*<svg[\s>]/i.test(e.markup);
    rmSync(join(dir, isSvg ? "element.html" : "element.svg"), { force: true });
    writeFileSync(join(dir, isSvg ? "element.svg" : "element.html"), e.markup);
    writeFileSync(join(dir, "meta.json"), JSON.stringify(e.note ? { kind: e.kind, note: e.note } : { kind: e.kind }, null, 2) + "\n");
    writeFileSync(join(dir, "style.css"), e.css);
    writeFileSync(join(dir, "params.json"), JSON.stringify(e.params, null, 2) + "\n");
    writeFileSync(join(dir, "motion.json"), JSON.stringify(e.motion, null, 2) + "\n");
    rmSync(join(dir, "variants"), { recursive: true, force: true });
    mkdirSync(join(dir, "variants"));
    for (const [vid, v] of Object.entries(e.variants)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(vid)) throw new StudioError("bad_id", `invalid variant id "${vid}"`);
      writeFileSync(join(dir, "variants", `${vid}.json`), JSON.stringify(v, null, 2) + "\n");
    }
    this.commit(`put ${e.id}`);
  }

  /** Set one or many params, on the base element or on a variant (created if missing). */
  setParams(id: string, values: Record<string, string | number>, variant?: string): ElementDef {
    const e = this.get(id);
    const names = new Set(e.params.map((p) => p.name));
    for (const k of Object.keys(values)) if (!names.has(k)) throw new StudioError("bad_param", `element "${id}": unknown param "${k}"`);
    if (variant) e.variants[variant] = { ...(e.variants[variant] ?? {}), ...values };
    else for (const p of e.params) if (p.name in values) p.value = values[p.name];
    this.put(e);
    return e;
  }

  remove(id: string): void {
    rmSync(this.elDir(id), { recursive: true, force: true });
    this.commit(`remove ${id}`);
  }

  // ---- history -------------------------------------------------------------------------------------------
  private git(...args: string[]): string {
    return execFileSync("git", ["--git-dir", join(this.projectDir, ".history"), "--work-tree", this.projectDir, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_AUTHOR_NAME: "studio", GIT_AUTHOR_EMAIL: "studio@localhost", GIT_COMMITTER_NAME: "studio", GIT_COMMITTER_EMAIL: "studio@localhost" },
    });
  }

  private ensureHistory() {
    if (!existsSync(join(this.projectDir, ".history"))) {
      execFileSync("git", ["init", "-q", "--bare", join(this.projectDir, ".history")]);
      writeFileSync(join(this.projectDir, ".history", "info", "exclude"), ".history/\nfeedback.jsonl\nrefs/\nexport-state.json\n");
    }
  }

  commit(message: string): void {
    this.ensureHistory();
    this.git("add", "-A");
    try { this.git("commit", "-q", "--allow-empty-message", "-m", message); } catch { /* nothing to commit */ }
  }

  snapshot(name: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new StudioError("bad_id", `invalid snapshot name "${name}"`);
    this.commit(`snapshot ${name}`);
    this.git("tag", "-f", name);
  }

  snapshots(): string[] {
    this.ensureHistory();
    return this.git("tag", "--list").split("\n").filter(Boolean);
  }

  restore(name: string): void {
    if (!this.snapshots().includes(name)) throw new StudioError("not_found", `no snapshot "${name}"`);
    this.commit("before restore");
    rmSync(join(this.projectDir, "elements"), { recursive: true, force: true });
    this.git("checkout", name, "--", ".");
    mkdirSync(join(this.projectDir, "elements"), { recursive: true });
    this.commit(`restore ${name}`);
  }
}
