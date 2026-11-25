// One-off import of the Bringup page's tokens and EN/SR strings into projects/bringup (re-runnable).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const site = process.argv[2], dir = process.argv[3];
const html = readFileSync(site, "utf8");
const block = (re: RegExp) => Object.fromEntries([...(html.match(re)?.[1] ?? "").matchAll(/--([\w-]+):([^;]+)/g)].map((m) => [m[1], m[2].trim()]));
const light = block(/:root\{([^}]*)\}/);
const dark = block(/:root\[data-theme="dark"\]\{([^}]*)\}/);
const color: Record<string, { light: string; dark: string }> = {}, font: Record<string, string> = {};
for (const [k, v] of Object.entries(light)) {
  if (k.startsWith("f-")) font[k] = v;
  else color[k] = { light: v, dark: dark[k] ?? v };
}
const tokens = { color, font, size: { radius: "6px", "radius-lg": "10px" }, ease: { out: "cubic-bezier(.2,.8,.2,1)" }, dur: { fast: "150ms" } };
writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokens, null, 2) + "\n");
const en: Record<string, string> = {};
for (const m of html.matchAll(/<([a-z0-9]+)[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/g)) en[m[2]] = m[3];
const srSrc = html.match(/var sr = (\{[\s\S]*?\});/)![1];
const sr = Function(`return ${srSrc}`)();
writeFileSync(join(dir, "strings.json"), JSON.stringify({ en, sr }, null, 2) + "\n");
writeFileSync(join(dir, "project.json"), JSON.stringify({ site }, null, 2) + "\n");
console.log(`tokens: ${Object.keys(color).length} colours, ${Object.keys(font).length} fonts; strings: en ${Object.keys(en).length}, sr ${Object.keys(sr).length}`);
