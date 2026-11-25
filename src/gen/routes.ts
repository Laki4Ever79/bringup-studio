import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { body, route, STUDIO_ROOT } from "../server/app.ts";
import { DEFAULT_LEDGER, estimate, generate, loadEnv, spendTotals, type GenReq } from "./generate.ts";

const ledger = () => process.env.STUDIO_LEDGER ?? DEFAULT_LEDGER;

route("GET", /^\/api\/gen\/estimate$/, (_q, _r, _m, _ctx, q) =>
  ({ usd: estimate({ provider: (q.get("provider") ?? "openai") as GenReq["provider"], count: Number(q.get("count") ?? 1), quality: q.get("quality") ?? undefined }) }));

route("GET", /^\/api\/spend$/, () => spendTotals(ledger()));

route("GET", /^\/api\/refs$/, (_q, _r, _m, ctx) => {
  const d = join(ctx.projectDir, "refs");
  return existsSync(d) ? readdirSync(d).filter((f) => /\.(png|jpe?g|webp|gif|svg)$/i.test(f)).sort() : [];
});

/** POST /api/gen {prompt, provider, count, quality?, refs?: string[] (ref names)}. A click in the studio is the approval. */
route("POST", /^\/api\/gen$/, async (req, _r, _m, ctx) => {
  const b = await body(req);
  const refsDir = join(ctx.projectDir, "refs");
  const refs = (b.refs ?? []).map((r: string) => readFileSync(join(refsDir, basename(r))));
  const out = await generate({ provider: b.provider ?? "openai", prompt: String(b.prompt ?? ""), count: Number(b.count ?? 1), quality: b.quality, model: b.model },
    { outDir: refsDir, ledgerPath: ledger(), project: ctx.project, env: { ...loadEnv(STUDIO_ROOT), ...process.env }, refs });
  const names = out.images.map((p) => basename(p));
  ctx.feedback.add({ kind: "generate", text: String(b.prompt ?? ""), meta: { provider: b.provider, count: names.length, usd: out.usd, images: names } });
  ctx.broadcast({ type: "refs" });
  ctx.broadcast({ type: "feedback", item: ctx.feedback.all().at(-1) });
  return { images: names, usd: out.usd, model: out.model };
});
