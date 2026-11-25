# Bringup Studio

A design studio built for an agent. Claude designs logos, buttons, UI elements and animations as code (SVG, CSS,
parameters, motion tracks) through an MCP server; you watch and judge in a live browser studio.

- **Show fast, reliably.** Every change reloads the studio within ~50 ms. Claude renders headless (Playwright) and
  checks its own work before calling `studio_show`, which focuses your tab (and opens one if none is open).
- **Exact control.** Every tunable value is a named param (`--<element>-<param>` CSS var) or a keyframe in
  `motion.json`. Variants are small param overrides, shown side by side.
- **Feedback.** Pick a tile, Alt-click to pin a comment on a spot, "More like this", or generate reference images.
  Claude reads it all with `studio_feedback`.
- **Tracing.** Raster to SVG with vtracer/potrace, a settings search, and a measured score (pixel IoU + edge match).
  Flat logos must reach IoU ≥ 0.98. Paths that are really rectangles or circles become `<rect>`/`<circle>`.
- **Generation.** OpenAI (`gpt-image-1`) or Gemini (Imagen 4) reference images. The button shows the price; every
  call is logged to `~/.bringup/spend.jsonl` (`source: "studio"`), and the studio shows today / all-time spend.
- **Export.** Elements live in the site between `studio:` markers. Export only writes inside markers, and refuses if
  you edited there by hand (import it back instead).

## Run

```bash
npm install
bash scripts/setup-tools.sh        # vtracer into .venv (tracing only)
npm start                          # studio at http://127.0.0.1:4747 (project: bringup)
claude mcp add --scope user bringup-studio -- "$PWD/bin/studio-mcp"   # the MCP server starts the studio itself
```

Keys: `OPENAI_API_KEY` / `GEMINI_API_KEY` from `bringup-studio/.env`, falling back to `../agent-mesh/.env`.
Env: `STUDIO_PORT` (4747), `STUDIO_PROJECT` (bringup), `STUDIO_SESSION` (session name shown in the studio).

## Layout

```
projects/<name>/
  project.json          {"site": "/abs/path/index.html"}
  tokens.json           colours (light/dark), fonts, sizes, easings, durations
  strings.json          {en: {...}, sr: {...}} for data-i18n keys
  elements/<id>/        meta.json, element.svg|html, style.css, params.json, motion.json, variants/<v>.json
  refs/                 generated images, trace overlays
  export-state.json     hashes of what the studio last wrote into the site
  .history/             per-save git history (snapshots are tags); not in this repo
src/model     types, compiler (tokens/params/motion → CSS), store
src/server    HTTP API, WebSocket live reload, feedback, single-writer lock
src/render    Playwright renders (png, frame strips, gif), board preview
src/trace     vtracer/potrace + scorer + search + cleanup
src/gen       image providers, price table, spend ledger
src/export    adopt / export / import against the site's markers
src/mcp       the MCP tools
studio/       the browser studio
```

## Tests

`npm test` (no paid calls; the generator has a mock provider) and `npm run typecheck`.
