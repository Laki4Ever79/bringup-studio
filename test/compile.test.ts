import { test } from "node:test";
import assert from "node:assert/strict";
import { compileTokens, compileElement, elementPage } from "../src/model/compile.ts";
import type { ElementDef } from "../src/model/types.ts";
import { tokens, btn } from "./fixtures.ts";

test("compileTokens emits light and both dark blocks with the site's selectors", () => {
  const css = compileTokens(tokens);
  const root = css.slice(0, css.indexOf("}"));
  assert.match(root, /^:root\{/);
  assert.match(root, /--mask:#0E5A4A/);
  assert.match(root, /--f-body:"IBM Plex Sans"/);
  assert.match(root, /--fast:160ms/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{[^}]*--mask:#3FA88C/);
  assert.match(css, /:root\[data-theme="dark"\]\{[^}]*--mask:#3FA88C/);
});

test("compileElement scopes params as vars and applies a variant with the param unit", () => {
  const base = compileElement(btn);
  assert.match(base.css, /\[data-studio="btn"\]\{--btn-stroke:2px\}/);
  const v = compileElement(btn, "thick");
  assert.match(v.css, /--btn-stroke:3px/);
  assert.match(v.markup, /^<a data-studio="btn" class="btn" href="#join" data-i18n="cta">/);
});

test("compileElement rejects an unknown variant", () => {
  assert.throws(() => compileElement(btn, "nope"), /variant "nope"/);
});

test("motion tracks compile to keyframes with per-keyframe easing", () => {
  const el: ElementDef = {
    ...btn,
    motion: [{
      selector: "&", property: "opacity", duration: "1s", iterations: 1,
      keyframes: [{ offset: 0, value: "0", ease: "ease-in" }, { offset: 0.5, value: "0.6" }, { offset: 1, value: "1" }],
    }],
  };
  const { css } = compileElement(el);
  assert.match(css, /@keyframes btn-0\{0%\{opacity:0;animation-timing-function:ease-in\}50%\{opacity:0.6\}100%\{opacity:1\}\}/);
  assert.match(css, /\[data-studio="btn"\]\{animation:btn-0 1s 0s 1 both\}/);
});

test("elementPage is a standalone document with theme, lang and the element", () => {
  const html = elementPage({ tokens, el: btn, theme: "dark", lang: "sr", strings: { sr: { cta: "Prijavi se" } } });
  assert.match(html, /<html lang="sr" data-theme="dark">/);
  assert.match(html, /data-studio="btn"/);
  assert.match(html, /Prijavi se/);
});

test("an element with a scope carries its params on that selector", () => {
  const { css } = compileElement({ ...btn, scope: ".btn" });
  assert.match(css, /^\.btn\{--btn-stroke:2px\}/);
});

test("wide kinds (illustration, section) preview on a 720px stage; small kinds stay centred", () => {
  const wide = elementPage({ tokens, el: { ...btn, kind: "illustration" }, theme: "light" });
  assert.match(wide, /<div class="studio-stage" style="width:min\(100%,720px\)">/);
  const small = elementPage({ tokens, el: btn, theme: "light" });
  assert.doesNotMatch(small, /studio-stage" style/);
});
