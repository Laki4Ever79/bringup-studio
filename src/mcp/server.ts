import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

export type McpDeps = {
  base: string; // studio server URL
  session: string;
  open: (url: string) => Promise<void>;
  cursorDir: string; // where the feedback cursor is kept
  shareDir?: string;
  showWaitMs?: number;
};

export const TOOL_NAMES = [
  "studio_tokens_get", "studio_tokens_set", "studio_elements_list", "studio_element_get", "studio_element_put",
  "studio_params_set", "studio_variant_create", "studio_motion_set", "studio_render", "studio_show", "studio_feedback",
  "studio_status", "studio_lock", "studio_unlock", "studio_trace", "studio_generate", "studio_adopt", "studio_export",
  "studio_import", "studio_snapshot", "studio_restore", "studio_share",
] as const;

const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });
const json = (v: unknown): Result => text(JSON.stringify(v, null, 2));

const Param = z.object({
  name: z.string(), type: z.enum(["color", "length", "number", "string", "ease", "duration"]),
  value: z.union([z.string(), z.number()]), unit: z.string().optional(), min: z.number().optional(), max: z.number().optional(), note: z.string().optional(),
});
const Track = z.object({
  selector: z.string().describe('"&" = the element root; otherwise a selector inside it'),
  property: z.string(), duration: z.string(), delay: z.string().optional(),
  iterations: z.union([z.number(), z.literal("infinite")]).optional(),
  keyframes: z.array(z.object({ offset: z.number().min(0).max(1), value: z.string(), ease: z.string().optional() })).min(2),
});

export function createMcp(d: McpDeps): McpServer {
  const server = new McpServer({ name: "bringup-studio", version: "0.1.0" }, {
    instructions:
      "Bringup Studio: design logos, buttons, UI elements and animations as code (SVG/CSS + params + motion). " +
      "Loop: edit (element_put / params_set / motion_set) → studio_render and LOOK at it yourself → fix → studio_show " +
      "to put it in front of the user → studio_feedback for their picks/comments. Never show what you have not rendered. " +
      "Every value lives in params (exposed as --<id>-<name> CSS vars) so single values can be tuned exactly. " +
      "studio_generate costs money: call it only when the user asked for generated images in this conversation.",
  });

  async function api(path: string, init: RequestInit = {}): Promise<Response> {
    const r = await fetch(d.base + path, { ...init, headers: { "content-type": "application/json", "x-studio-session": d.session, ...(init.headers ?? {}) } });
    if (!r.ok) {
      const e = await r.json().catch(() => ({ message: r.statusText }));
      throw new Error(`${e.error ?? r.status}: ${e.message ?? ""}${e.holder ? ` (holder: ${e.holder})` : ""}`);
    }
    return r;
  }
  const get = async (p: string) => (await api(p)).json();
  const post = async (p: string, b: unknown, method = "POST") => (await api(p, { method, body: JSON.stringify(b ?? {}) })).json();

  function tool<S extends z.ZodRawShape>(name: (typeof TOOL_NAMES)[number], description: string, shape: S, fn: (a: z.objectOutputType<S, z.ZodTypeAny>) => Promise<Result>) {
    server.registerTool(name, { description, inputSchema: shape }, (async (a: any) => {
      try { return await fn(a); } catch (e) { return { ...text(String((e as Error).message ?? e)), isError: true }; }
    }) as any);
  }

  tool("studio_tokens_get", "Read the project's design tokens (colours light/dark, fonts, sizes, easings, durations).", {}, async () => json(await get("/api/tokens")));
  tool("studio_tokens_set", "Replace the project's design tokens. Pass the whole object (read it first).",
    { tokens: z.object({ color: z.record(z.object({ light: z.string(), dark: z.string() })), font: z.record(z.string()).optional(), size: z.record(z.string()).optional(), ease: z.record(z.string()).optional(), dur: z.record(z.string()).optional() }) },
    async (a) => json(await post("/api/tokens", a.tokens, "PUT")));
  tool("studio_elements_list", "List elements with their kind and variants.", {}, async () => {
    const ids: string[] = await get("/api/elements");
    const rows = await Promise.all(ids.map(async (id) => { const e = await get(`/api/elements/${id}`); return `${id} (${e.kind}) variants: ${["base", ...Object.keys(e.variants)].join(", ")}`; }));
    return text(rows.join("\n") || "no elements yet");
  });
  tool("studio_element_get", "Read one element: markup, css, params, motion, variants.", { id: z.string() }, async (a) => json(await get(`/api/elements/${a.id}`)));
  tool("studio_element_put", "Create or replace an element. Markup is SVG or HTML; CSS may use var(--<id>-<param>). scope: optional selector carrying the params (default [data-studio=\"<id>\"]).", {
    id: z.string(), kind: z.enum(["logo", "button", "icon", "section", "animation", "illustration"]), markup: z.string(), css: z.string().default(""),
    params: z.array(Param).default([]), motion: z.array(Track).default([]), variants: z.record(z.record(z.union([z.string(), z.number()]))).default({}),
    note: z.string().optional(), scope: z.string().optional(),
  }, async (a) => json(await post(`/api/elements/${a.id}`, a, "PUT")));
  tool("studio_params_set", "Set one or many param values on the base element, or on a variant (created if missing).",
    { id: z.string(), values: z.record(z.union([z.string(), z.number()])), variant: z.string().optional() },
    async (a) => { await post(`/api/elements/${a.id}/params`, { values: a.values, variant: a.variant }); return text(`set ${Object.keys(a.values).join(", ")} on ${a.id}${a.variant ? "/" + a.variant : ""}`); });
  tool("studio_variant_create", "Create a variant as a param override set (cheap A/B/C options for the user to pick from).",
    { id: z.string(), name: z.string(), values: z.record(z.union([z.string(), z.number()])) },
    async (a) => { await post(`/api/elements/${a.id}/params`, { values: a.values, variant: a.name }); return text(`variant ${a.id}/${a.name} saved`); });
  tool("studio_motion_set", "Replace an element's motion tracks (compiled to CSS @keyframes, per-keyframe easing).",
    { id: z.string(), motion: z.array(Track) },
    async (a) => { const e = await get(`/api/elements/${a.id}`); e.motion = a.motion; await post(`/api/elements/${a.id}`, e, "PUT"); return text(`${a.motion.length} track(s) on ${a.id}`); });

  tool("studio_render", "Render and return an image for YOU to check: an element (clipped), a board of variants, or the whole page with studio exports applied. frames=[ms,…] returns a strip; gif=true an animation.", {
    target: z.enum(["element", "board", "page"]).default("element"), id: z.string().optional(), variant: z.string().optional(),
    variants: z.array(z.string()).optional(), theme: z.enum(["light", "dark", "both"]).default("light"), lang: z.enum(["en", "sr"]).default("en"),
    width: z.number().optional(), height: z.number().optional(), scale: z.number().optional(), frames: z.array(z.number()).optional(),
    gif: z.boolean().optional(), duration: z.number().optional(), fps: z.number().optional(), full: z.boolean().optional(),
  }, async (a) => {
    const q = new URLSearchParams({ target: a.target, theme: a.theme, lang: a.lang });
    for (const k of ["id", "variant", "width", "height", "scale", "duration", "fps"] as const) if (a[k] !== undefined) q.set(k, String(a[k]));
    if (a.variants) q.set("variants", a.variants.join(","));
    if (a.frames) q.set("frames", a.frames.join(","));
    if (a.gif) q.set("gif", "1");
    if (a.full === false) q.set("full", "0");
    const r = await api(`/api/render?${q}`);
    const mime = r.headers.get("content-type") ?? "image/png";
    const data = Buffer.from(await r.arrayBuffer()).toString("base64");
    return { content: [{ type: "image", data, mimeType: mime }, { type: "text", text: `${a.target}${a.id ? " " + a.id : ""}${a.variant ? "/" + a.variant : ""} · ${a.theme} · ${a.lang}` }] };
  });

  tool("studio_show", "Put something in front of the user in the studio (opens a browser tab if none is connected). Only show what you rendered and checked.", {
    view: z.enum(["board", "page", "motion"]).default("board"), element: z.string().optional(), variants: z.array(z.string()).optional(),
    note: z.string().optional().describe("one line the user sees, e.g. what changed and what to judge"),
    theme: z.enum(["light", "dark", "both"]).optional(), lang: z.enum(["en", "sr"]).optional(), width: z.number().optional(),
  }, async (a) => {
    let r = await post("/api/show", a);
    if (r.clients > 0) return text(`shown to ${r.clients} studio tab(s)`);
    const url = `${d.base}/#${a.view}${a.element && a.view !== "page" ? "/" + a.element : ""}`;
    await d.open(url);
    const until = Date.now() + (d.showWaitMs ?? 5000);
    while (Date.now() < until) {
      await new Promise((res) => setTimeout(res, 250));
      r = await post("/api/show", a);
      if (r.clients > 0) break;
    }
    return text(r.clients > 0 ? `opened ${url} and shown` : `opened ${url} (tab not connected yet; it will load this view)`);
  });

  const cursorFile = join(d.cursorDir, `feedback-cursor-${d.session.replace(/[^a-z0-9_-]/gi, "_")}.json`);
  tool("studio_feedback", "Read the user's new picks, pinned comments, 'more like this' and generations since your last read.", {}, async () => {
    const since = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")).cursor : 0;
    const r = await get(`/api/feedback?since=${since}`);
    mkdirSync(d.cursorDir, { recursive: true });
    writeFileSync(cursorFile, JSON.stringify({ cursor: r.cursor }));
    if (!r.items.length) return text("no new feedback");
    return text(r.items.map((f: any) => {
      const at = f.x != null ? ` at (${f.x},${f.y})` : "";
      const what = f.kind === "comment" ? `comment ${f.element ?? ""}${f.variant ? "/" + f.variant : ""}${at}: ${f.text}`
        : f.kind === "generate" ? `generated ${f.meta?.count} image(s) via ${f.meta?.provider} ($${f.meta?.usd}): "${f.text}" → refs ${(f.meta?.images ?? []).join(", ")}`
        : `${f.kind} ${f.element ?? ""}${f.variant ? "/" + f.variant : ""}`;
      return `[${f.at.slice(11, 19)}] ${what}`;
    }).join("\n"));
  });

  tool("studio_status", "Tell the user what you're working on (shown in the studio's status strip).", { text: z.string() },
    async (a) => { await post("/api/status", { session: d.session, text: a.text }); return text("ok"); });
  tool("studio_lock", "Take the single-writer lock for this session (writes take it automatically).", {}, async () => json(await post("/api/lock", {})));
  tool("studio_unlock", "Release the lock so another session can write.", {}, async () => json(await post("/api/lock", {}, "DELETE")));

  tool("studio_trace", "Trace a raster image (absolute path, or a ref name) into SVG with a fidelity score; returns the source/trace diff overlay (red = missed ink, blue = extra). Flat logos must reach IoU ≥ 0.98.", {
    path: z.string().optional(), ref: z.string().optional(), mode: z.enum(["color", "mono"]).default("color"),
    element: z.string().optional().describe("save the SVG as this element"), kind: z.enum(["logo", "icon", "illustration"]).optional(),
    snap: z.boolean().optional().describe("snap fills to the project's colour tokens"), gate: z.number().optional(),
  }, async (a) => {
    const r = await post("/api/trace", a);
    const overlay = readFileSync(r.overlayPath).toString("base64");
    return { content: [
      { type: "text", text: `iou ${r.iou.toFixed(4)} · edge ${r.edge.toFixed(3)} · ${r.passed ? "PASSED" : "below gate"} · ${r.iterations} tries · settings ${JSON.stringify(r.settings)}${a.element ? ` · saved as ${a.element}` : ""}\n\n${r.svg.length > 4000 ? r.svg.slice(0, 4000) + "\n…(truncated)" : r.svg}` },
      { type: "image", data: overlay, mimeType: "image/png" },
    ] };
  });

  tool("studio_generate", "COSTS MONEY (except provider=mock). Generate reference images with OpenAI or Gemini. Only call when the user asked for generated images in this conversation. Each call is logged to the spend ledger.", {
    prompt: z.string(), provider: z.enum(["openai", "gemini", "mock"]), count: z.number().int().min(1).max(4).default(1),
    quality: z.enum(["low", "medium", "high"]).optional(), refs: z.array(z.string()).optional(),
  }, async (a) => {
    const r = await post("/api/gen", a);
    return text(`${r.images.length} image(s), $${r.usd} (${r.model}) → refs: ${r.images.join(", ")}`);
  });

  tool("studio_adopt", "One-time: wrap an element of the site in studio markers (backup + diff) and create the studio element from it. markup = a unique attribute needle like 'class=\"robot\"'; css = selectors whose rules belong to it. id 'tokens' adopts the token blocks.", {
    id: z.string(), markup: z.string().optional(), css: z.array(z.string()).default([]), kind: z.enum(["logo", "button", "icon", "section", "animation", "illustration"]).optional(),
    sample: z.string().optional().describe("preview markup for CSS-only adopts (e.g. one <a class=\"btn\">); studio-only, never exported"),
  }, async (a) => {
    const r = await post("/api/adopt", a);
    return text(`adopted ${a.id}${r.created ? " (element created)" : ""}; backup ${r.backup}\n\n${r.diff}`);
  });
  tool("studio_export", "Write an element's current version (or a variant) into the site, inside its markers. Refuses if the page was hand-edited there.", { id: z.string(), variant: z.string().optional() },
    async (a) => json(await post("/api/export", a)));
  tool("studio_import", "Accept a hand edit: pull the page's current marker content back into the studio element.", { id: z.string() },
    async (a) => json(await post("/api/import", a)));
  tool("studio_snapshot", "Name the current state of the project so it can be restored.", { name: z.string() }, async (a) => json(await post("/api/snapshots", a)));
  tool("studio_restore", "Restore a named snapshot (the site is not touched until the next export).", { name: z.string() }, async (a) => json(await post("/api/restore", a)));

  tool("studio_share", "Write a self-contained HTML board for publishing as a claude.ai Artifact (to view on a phone). Returns the file path.", {
    id: z.string(), theme: z.enum(["light", "dark", "both"]).default("both"), lang: z.enum(["en", "sr"]).default("en"), variants: z.array(z.string()).optional(),
  }, async (a) => {
    const q = new URLSearchParams({ theme: a.theme, lang: a.lang });
    if (a.variants) q.set("variants", a.variants.join(","));
    let html = await (await api(`/preview/board/${a.id}?${q}`)).text();
    html = html.replace("<head>", `<head><title>${a.id} board</title><meta name="viewport" content="width=device-width,initial-scale=1">`);
    const dir = d.shareDir ?? join(d.cursorDir, "share");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${a.id}-board.html`);
    writeFileSync(p, html);
    return text(p);
  });

  return server;
}
