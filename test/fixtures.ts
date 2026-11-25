import type { ElementDef, Tokens } from "../src/model/types.ts";

export const tokens: Tokens = {
  color: { paper: { light: "#F6F7F4", dark: "#0F1613" }, mask: { light: "#0E5A4A", dark: "#3FA88C" } },
  font: { "f-body": '"IBM Plex Sans", system-ui, sans-serif' },
  size: { r: "6px" },
  ease: { out: "cubic-bezier(.2,.8,.2,1)" },
  dur: { fast: "160ms" },
};

export const btn: ElementDef = {
  id: "btn",
  kind: "button",
  markup: '<a class="btn" href="#join" data-i18n="cta">Join</a>',
  css: ".btn{border-width:var(--btn-stroke)}",
  params: [{ name: "stroke", type: "length", value: 2, unit: "px" }],
  motion: [],
  variants: { thick: { stroke: 3 } },
};

