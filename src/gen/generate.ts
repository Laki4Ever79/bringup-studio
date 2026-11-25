import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { StudioError } from "../model/types.ts";

/** USD per image. Keys: "<provider>:<model>:<size>:<quality>". */
export const PRICES: Record<string, number> = {
  "openai:gpt-image-1:1024x1024:low": 0.011,
  "openai:gpt-image-1:1024x1024:medium": 0.042,
  "openai:gpt-image-1:1024x1024:high": 0.167,
  "gemini:imagen-4.0-generate-001:1024x1024:standard": 0.04,
  "mock:mock:1024x1024:standard": 0,
};

export type GenReq = { provider: "openai" | "gemini" | "mock"; model?: string; size?: string; quality?: string; count: number };
type Deps = { outDir: string; ledgerPath?: string; project: string; fetch?: typeof fetch; env?: Record<string, string | undefined>; refs?: Buffer[] };

export const DEFAULT_LEDGER = join(homedir(), ".bringup", "spend.jsonl");

function resolved(r: GenReq) {
  const model = r.model ?? (r.provider === "openai" ? "gpt-image-1" : r.provider === "gemini" ? "imagen-4.0-generate-001" : "mock");
  const size = r.size ?? "1024x1024";
  const quality = r.quality ?? (r.provider === "openai" ? "medium" : "standard");
  return { model, size, quality, key: `${r.provider}:${model}:${size}:${quality}` };
}

export function estimate(r: GenReq): number {
  const { key } = resolved(r);
  const unit = PRICES[key];
  if (unit === undefined) throw new StudioError("bad_param", `no price for ${key}; add it to PRICES before spending`);
  return Math.round(unit * Math.max(1, r.count) * 1e6) / 1e6;
}

/** Read KEY=VALUE pairs from the studio's .env, falling back to agent-mesh's. */
export function loadEnv(studioRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of [resolve(studioRoot, "../agent-mesh/.env"), join(studioRoot, ".env")]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  }
  return out;
}

async function openai(prompt: string, n: number, model: string, size: string, quality: string, d: Deps, key: string): Promise<() => Buffer[]> {
  const f = d.fetch ?? fetch;
  let res: Response;
  if (d.refs?.length) {
    const form = new FormData();
    form.set("model", model); form.set("prompt", prompt); form.set("n", String(n)); form.set("size", size); form.set("quality", quality);
    d.refs.forEach((b, i) => form.append("image[]", new Blob([new Uint8Array(b)], { type: "image/png" }), `ref${i}.png`));
    res = await f("https://api.openai.com/v1/images/edits", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  } else {
    res = await f("https://api.openai.com/v1/images/generations", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, n, size, quality }),
    });
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new StudioError("provider", `OpenAI: ${j?.error?.message ?? res.statusText}`);
  return () => decode((j.data ?? []).map((x: any) => x?.b64_json), "OpenAI");
}

async function gemini(prompt: string, n: number, model: string, d: Deps, key: string): Promise<() => Buffer[]> {
  const f = d.fetch ?? fetch;
  const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`, {
    method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: n } }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new StudioError("provider", `Gemini: ${j?.error?.message ?? res.statusText}`);
  return () => decode((j.predictions ?? []).map((p: any) => p?.bytesBase64Encoded), "Gemini");
}

function decode(b64s: unknown[], who: string): Buffer[] {
  const out = b64s.filter((b): b is string => typeof b === "string" && b.length > 0).map((b) => Buffer.from(b, "base64"));
  if (!out.length) throw new StudioError("provider", `${who} answered OK but sent no images (the call is still logged as spent)`);
  return out;
}

function mock(n: number, prompt: string): Buffer[] {
  let h = 0;
  for (const c of prompt) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Array.from({ length: n }, (_, i) => {
    const p = new PNG({ width: 256, height: 256 });
    const col = [(h >> 16) & 255, (h >> 8) & 255, (h + i * 70) & 255];
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const k = (y * 256 + x) * 4, inside = Math.hypot(x - 128, y - 128) < 60 + i * 12;
      p.data[k] = inside ? col[0] : 255; p.data[k + 1] = inside ? col[1] : 255; p.data[k + 2] = inside ? col[2] : 255; p.data[k + 3] = 255;
    }
    return PNG.sync.write(p);
  });
}

/** Generate reference images. Paid providers log one ledger line per successful call; failures log nothing. */
export async function generate(r: GenReq & { prompt: string }, d: Deps): Promise<{ images: string[]; usd: number; model: string }> {
  const count = Math.min(4, Math.max(1, Math.floor(r.count || 1)));
  const { model, size, quality } = resolved(r);
  const usd = estimate({ ...r, count });
  const env = d.env ?? process.env;
  let take: () => Buffer[];
  if (r.provider === "mock") { const m = mock(count, r.prompt); take = () => m; }
  else if (r.provider === "openai") {
    const key = env.OPENAI_API_KEY;
    if (!key) throw new StudioError("no_key", "Add OPENAI_API_KEY to bringup-studio/.env");
    take = await openai(r.prompt, count, model, size, quality, d, key);
  } else if (r.provider === "gemini") {
    const key = env.GEMINI_API_KEY;
    if (!key) throw new StudioError("no_key", "Add GEMINI_API_KEY to bringup-studio/.env");
    take = await gemini(r.prompt, count, model, d, key);
  } else throw new StudioError("bad_param", `unknown provider "${r.provider}"`);

  const ledger = d.ledgerPath ?? DEFAULT_LEDGER;
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), usd, model: `${r.provider}:${model}`, source: "studio", where: `studio/${d.project}: ${r.prompt.slice(0, 80)}` }) + "\n");

  const bufs = take(); // decode after logging: a paid call is recorded even if its body is unusable
  mkdirSync(d.outDir, { recursive: true });
  const stem = `gen-${Date.now()}`;
  const images = bufs.map((b, i) => {
    const p = join(d.outDir, `${stem}-${i}.png`);
    writeFileSync(p, b);
    return p;
  });
  writeFileSync(join(d.outDir, `${stem}.json`), JSON.stringify({ prompt: r.prompt, provider: r.provider, model, usd }, null, 2));
  return { images, usd, model };
}

export function spendTotals(ledgerPath = DEFAULT_LEDGER): { today: number; all: number } {
  if (!existsSync(ledgerPath)) return { today: 0, all: 0 };
  const day = new Date().toISOString().slice(0, 10);
  let today = 0, all = 0;
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.source !== "studio") continue;
      all += Number(e.usd) || 0;
      if (String(e.at).slice(0, 10) === day) today += Number(e.usd) || 0;
    } catch { /* skip bad lines */ }
  }
  return { today, all };
}
