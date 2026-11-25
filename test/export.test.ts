import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adopt, exportElement, importBack, applyInMemory } from "../src/export/site.ts";
import { StudioError } from "../src/model/types.ts";

function site() {
  const d = mkdtempSync(join(tmpdir(), "studio-exp-"));
  const p = join(d, "index.html");
  copyFileSync(new URL("./fixtures/site.html", import.meta.url), p);
  return { d, p, state: join(d, "export-state.json"), orig: readFileSync(p, "utf8") };
}
const strip = (s: string) => s.replace(/<!-- \/?studio:[a-z-]+ -->/g, "").replace(/\/\* \/?studio:[a-z-]+ \*\//g, "");

test("adopting .btn CSS wraps its rules; the rest of the file is unchanged apart from markers", () => {
  const { p, state, orig } = site();
  const r = adopt(p, { id: "btn", cssSelectors: [".btn"] }, state);
  const now = readFileSync(p, "utf8");
  assert.ok(existsSync(r.backup));
  assert.match(r.diff, /studio:btn/);
  assert.match(now, /\/\* studio:btn \*\/[\s\S]*\.btn\{font:600 16px[\s\S]*\/\* \/studio:btn \*\//);
  // the combined focus rule (.lang button…,.btn:focus-visible,…) is shared, so it stays where it was
  assert.match(now, /\.lang button:focus-visible,\.btn:focus-visible/);
  // every byte is kept: removing markers and whitespace gives the same CSS rules in the same file
  assert.equal(strip(now).replace(/\s+/g, "").length, orig.replace(/\s+/g, "").length);
  const body = (s: string) => s.slice(s.indexOf("</style>", s.lastIndexOf("<style")));
  assert.equal(body(now), body(orig));
});

test("adopting markup wraps the element in place", () => {
  const { p, state } = site();
  adopt(p, { id: "robot", markupNeedle: 'class="robot"', cssSelectors: [".robot"] }, state);
  const now = readFileSync(p, "utf8");
  assert.match(now, /<!-- studio:robot --><svg class="robot"[\s\S]*?<\/svg><!-- \/studio:robot -->/);
  assert.deepEqual(Object.keys(importBack(p, "robot")).sort(), ["css", "markup"]);
});

test("export replaces only the inside of the markers and keeps data-i18n", () => {
  const { p, state } = site();
  adopt(p, { id: "robot", markupNeedle: 'class="robot"', cssSelectors: [".robot"] }, state);
  const before = readFileSync(p, "utf8");
  const markup = '<svg class="robot" viewBox="0 0 10 10"><text data-i18n="svgPlate">plate</text></svg>';
  exportElement(p, "robot", { markup, css: ".robot{width:50%}" }, state);
  const after = readFileSync(p, "utf8");
  assert.match(after, /<!-- studio:robot -->\n?<svg class="robot" viewBox="0 0 10 10"><text data-i18n="svgPlate">/);
  assert.match(after, /\/\* studio:robot \*\/\n?\.robot\{width:50%\}\n?\/\* \/studio:robot \*\//);
  const outside = (s: string) => s.replace(/<!-- studio:robot -->[\s\S]*?<!-- \/studio:robot -->/, "").replace(/\/\* studio:robot \*\/[\s\S]*?\/\* \/studio:robot \*\//, "");
  assert.equal(outside(after), outside(before));
});

test("a hand edit inside a marker refuses the export and leaves the file alone", () => {
  const { p, state } = site();
  adopt(p, { id: "btn", cssSelectors: [".btn"] }, state);
  writeFileSync(p, readFileSync(p, "utf8").replace(/(\/\* studio:btn \*\/[\s\S]*?)padding:14px 20px/, "$1padding:15px 21px"));
  const edited = readFileSync(p, "utf8");
  assert.throws(() => exportElement(p, "btn", { css: ".btn{padding:1px}" }, state),
    (e: unknown) => e instanceof StudioError && e.code === "hand_edited" && /btn/.test(e.message));
  assert.equal(readFileSync(p, "utf8"), edited);
  assert.match(importBack(p, "btn").css ?? "", /padding:15px 21px/);
});

test("exporting an element that was never adopted is a not_adopted error", () => {
  const { p, state } = site();
  assert.throws(() => exportElement(p, "logo", { css: "x{}" }, state), (e: unknown) => e instanceof StudioError && e.code === "not_adopted");
});

test("tokens adopt the three token blocks", () => {
  const { p, state } = site();
  adopt(p, { id: "tokens", cssSelectors: [":root", "@media (prefers-color-scheme: dark)", ':root[data-theme="dark"]'] }, state);
  const css = importBack(p, "tokens").css ?? "";
  assert.match(css, /--paper:#F6F7F4/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /prefers-color-scheme: dark/);
});

test("applyInMemory splices without touching disk or hashes", () => {
  const { p, state } = site();
  adopt(p, { id: "btn", cssSelectors: [".btn"] }, state);
  const html = applyInMemory(readFileSync(p, "utf8"), { btn: { css: ".btn{color:red}" }, ghost: { css: "x{}" } });
  assert.match(html, /\/\* studio:btn \*\/\n?\.btn\{color:red\}/);
});

test("routes: adopt creates the element, export writes it, a hand edit gets 409, preview splices", async () => {
  const { startServer } = await import("../src/server/app.ts");
  await import("../src/server/routes.ts");
  const { mkdirSync } = await import("node:fs");
  const { d, p } = site();
  mkdirSync(join(d, "projects/demo"), { recursive: true });
  writeFileSync(join(d, "projects/demo/project.json"), JSON.stringify({ site: p }));
  const srv = await startServer({ root: d, port: 0, project: "demo", watch: false });
  const post = (path: string, b: object) => fetch(srv.url + path, { method: "POST", headers: { "x-studio-session": "t" }, body: JSON.stringify(b) });
  try {
    const a = await (await post("/api/adopt", { id: "btn", css: [".btn"], kind: "button" })).json();
    assert.equal(a.created, true);
    const el = await (await fetch(srv.url + "/api/elements/btn")).json();
    assert.equal(el.scope, ".btn");
    el.params = [{ name: "radius", type: "length", value: 9, unit: "px" }];
    el.css = el.css.replace("border-radius:6px", "border-radius:var(--btn-radius)");
    await fetch(srv.url + "/api/elements/btn", { method: "PUT", headers: { "x-studio-session": "t" }, body: JSON.stringify(el) });
    const preview = await (await fetch(srv.url + "/preview/page")).text();
    assert.match(preview, /\.btn\{--btn-radius:9px\}/);
    assert.doesNotMatch(readFileSync(p, "utf8"), /--btn-radius/);
    assert.equal((await post("/api/export", { id: "btn" })).status, 200);
    assert.match(readFileSync(p, "utf8"), /\.btn\{--btn-radius:9px\}/);
    writeFileSync(p, readFileSync(p, "utf8").replace("--btn-radius:9px", "--btn-radius:3px"));
    const r = await post("/api/export", { id: "btn" });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "hand_edited");
  } finally { await srv.close(); }
});
