# Bringup Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, agent-driven design studio: an MCP server and a live browser studio for designing, rendering,
tracing, generating and exporting SVG/CSS elements and animations, with the Bringup page as its first project.

**Architecture:** One Node/TypeScript studio server owns a file-based project store. It serves the studio page,
pushes reloads over WebSocket, renders with Playwright, and exposes an HTTP API. A stdio MCP server is a thin client of
that API, and starts the studio server if it isn't running. Tracing shells out to vtracer (Python wheel in `.venv`) and
uses the `potrace` npm port.

**Tech Stack:** Node 24, TypeScript, tsx, node:test, `@modelcontextprotocol/sdk` 1.x, zod, ws, chokidar, playwright,
pngjs, pixelmatch, gifenc, potrace (npm), vtracer (pip, in `.venv`).

**Spec:** `/home/aleksa/Documents/3alet-hackathon/bringup-studio/docs/superpowers/specs/2026-11-25-bringup-studio-design.md`

## Global Constraints
- Repo: `/home/aleksa/Documents/3alet-hackathon/bringup-studio`, its own git repo. No system-wide installs: Python goes
  in `.venv/`, binaries in `tools/` (both gitignored).
- The server binds to `127.0.0.1` only. The default port is 4747 (env `STUDIO_PORT`).
- No paid calls in tests; the generator has a `mock` provider.
- Spend ledger: `~/.bringup/spend.jsonl`, one JSON line `{at, usd, model, source:"studio", where}` per paid call. No
  image cap.
- Trace gate for flat art: IoU ≥ 0.98.
- Exports are plain inline SVG and CSS, plus vanilla JS only where CSS can't do it. No libraries in the site.
- Export touches only the content between `studio:` markers, except the one-time adopt step (backup + diff first).
- Never commit `.env`. Keys are read from `bringup-studio/.env`, falling back to `agent-mesh/.env`.
- Commits carry no AI attribution lines (user rule).

## Review Focus
1. Hand-edited content inside a marker. Export must refuse with a clear message rather than overwrite it.
   Test in Task 7.
2. A Show when no studio tab is open. It must open one and not fail silently. Test in Task 8 (opener is injectable).
3. A malformed `params.json` / `motion.json` written by Claude. The compiler must return a readable error naming the
   file and field, and the server must not crash. Test in Task 1.
4. A trace of an image with alpha (a transparent logo PNG). Transparent pixels must count as background, not black.
   Test in Task 5.
5. A second session writing while another holds the lock. It must get a 423 error naming the holder. Test in Task 2.

---

## File Structure
```
src/
  model/types.ts         Tokens, ElementDef, Param, MotionTrack, Variant, Feedback types (zod schemas)
  model/compile.ts       tokens → CSS vars; params+variant → CSS vars; motion → @keyframes; element → standalone HTML
  model/store.ts         read/write project files; variants; git snapshots
  server/app.ts          HTTP API + static studio + WebSocket hub; startServer()
  server/watch.ts        chokidar → ws "reload" events
  server/feedback.ts     feedback.jsonl append/read with a cursor
  server/lock.ts         single-writer lock with expiry
  render/render.ts       Playwright: renderPng, renderFrames, renderGif
  trace/score.ts         IoU + edge score + diff overlay
  trace/trace.ts         vtracer/potrace runs + parameter search + cleanup
  gen/generate.ts        providers (openai, gemini, mock), price table, ledger
  export/site.ts         adopt, export, hash ownership, backup
  mcp/server.ts          stdio MCP tools → HTTP API; ensureServer()
  mcp/open.ts            browser opener (xdg-open), injectable
studio/index.html, studio/app.js, studio/style.css   the studio page
projects/bringup/        first project (tokens + adopted elements)
test/*.test.ts
```

---

### Task 1: Model and compiler

**Files:** Create `package.json`, `tsconfig.json`, `.gitignore`, `src/model/types.ts`, `src/model/compile.ts`,
`src/model/store.ts`, `test/compile.test.ts`, `test/store.test.ts`.

**Interfaces (produces):**
- `Tokens = { color: Record<string,{light:string,dark:string}>, font: Record<string,string>, size: Record<string,string>, ease: Record<string,string>, dur: Record<string,string> }`
- `Param = { name:string, type:"color"|"length"|"number"|"string"|"ease"|"duration", value:string|number, unit?:string, min?:number, max?:number }`
- `MotionTrack = { selector:string, property:string, keyframes:{offset:number, value:string, ease?:string}[], duration:string, delay?:string, iterations?:number|"infinite" }`
- `ElementDef = { id:string, kind:"logo"|"button"|"icon"|"section"|"animation"|"illustration", markup:string, css:string, params:Param[], motion:MotionTrack[], variants:Record<string,Record<string,string|number>> }`
- `compileTokens(t:Tokens): string`: a `:root{…}` block plus both dark blocks (the media-query guard and `[data-theme="dark"]`), using the site's exact selector pattern
- `compileElement(e:ElementDef, variant?:string): { css:string, markup:string }`: params become `--<id>-<name>` vars scoped to `[data-studio="<id>"]`; motion becomes `@keyframes <id>-<n>`
- `elementPage(p:{tokens:Tokens, el:ElementDef, variant?:string, theme:"light"|"dark", lang?:string, fontsHref?:string}): string`: a standalone HTML document
- `class Store(root:string)`: `tokens()`, `setTokens(t)`, `list()`, `get(id)`, `put(e)`, `setParams(id, values, variant?)`, `snapshot(name)`, `restore(name)`, `projectDir`
- `StudioError(code:string, message:string, detail?:object)`

- [ ] Write tests: `compileTokens` emits `--mask:#0E5A4A` in `:root` and `--mask:#3FA88C` in both dark blocks. `compileElement` with params `{stroke: 2px}` and a variant `{stroke: 3}` emits `--btn-stroke:3px`. A motion track with offsets 0/0.5/1 emits `0%`, `50%`, `100%` keyframes with `animation-timing-function` per keyframe. A bad params.json (`type:"colour"`) makes `store.get` throw a `StudioError` whose message names `params.json` and `type`.
- [ ] Run `npx tsx --test test/compile.test.ts test/store.test.ts`. Expected: FAIL.
- [ ] Implement. The element folder layout is the spec's (`element.svg|html`, `style.css`, `params.json`, `motion.json`, `variants/<vid>.json`). Snapshots are `git commit` + `git tag studio/<name>` inside the project dir's repo (the studio repo).
- [ ] Run the tests. Expected: PASS.
- [ ] `git init`, then commit "feat: element model, compiler and store".

### Task 2: Studio server, feedback, lock, live reload

**Files:** Create `src/server/app.ts`, `src/server/watch.ts`, `src/server/feedback.ts`, `src/server/lock.ts`,
`test/server.test.ts`.

**Interfaces:**
- `startServer(opts:{root:string, port:number, project:string}): Promise<{url:string, close():Promise<void>}>`
- Routes (JSON):
  - `GET /api/elements`
  - `GET|PUT /api/elements/:id`
  - `POST /api/elements/:id/params {values, variant?}`
  - `GET|PUT /api/tokens`
  - `GET /api/feedback?since=<n>`, returning `{items, cursor}`
  - `POST /api/feedback {kind:"pick"|"comment"|"more", element, variant?, x?, y?, text?}`
  - `POST /api/show {view:"board"|"page"|"motion", element?, variants?, note?}`, returning `{clients:number}`
  - `POST /api/status {session, text}`
  - `POST /api/lock {session}` / `DELETE /api/lock`
  - `GET /preview/element/:id?variant&theme&lang`, serving `elementPage` output
  - `GET /preview/page?theme&lang`, serving the site's HTML with current exports applied in memory
- Writes (PUT/POST on elements and tokens) require header `x-studio-session`. They return 423
  `{error:"locked", holder}` when another session holds the lock. The lock expires after 10 min idle.
- WebSocket `/ws` messages: `{type:"reload", element?}`, `{type:"show", …}`, `{type:"status", …}`.

- [ ] Write tests (start on port 0): PUT an element, then GET it back. Session B gets a 423 naming A while A holds the lock. A feedback POST and then `GET ?since=0` returns it with `cursor:1`. A WS client receives `reload` within 1 s of a `params` POST. `show` returns the connected client count.
- [ ] Run `npx tsx --test test/server.test.ts`. Expected: FAIL.
- [ ] Implement. Feedback is stored in `projects/<p>/feedback.jsonl`. The watcher is chokidar on the project dir, debounced 50 ms.
- [ ] Run the tests. Expected: PASS. Commit "feat: studio server with live reload, feedback and lock".

### Task 3: Renderer

**Files:** Create `src/render/render.ts`, `test/render.test.ts`.

**Interfaces:**
- `renderPng(url:string, o:{width:number, height?:number, theme:"light"|"dark", selector?:string, fullPage?:boolean}): Promise<Buffer>`
- `renderFrames(url, o & {times:number[]}): Promise<Buffer>`: a horizontal strip. Animations are paused through the
  Web Animations API (`document.getAnimations().forEach(a=>{a.pause(); a.currentTime=t})`) at each time.
- `renderGif(url, o & {fps:number, duration:number}): Promise<Buffer>`, encoded with gifenc.
- One shared browser instance, closed by `closeRenderer()`. Use Playwright's cached chromium (`~/.cache/ms-playwright`).

- [ ] Write tests on a data-URL page: `renderPng` returns a PNG of the given width. In dark theme the background pixel equals the dark `--paper`. `renderFrames` at t=0 and t=end of a 1 s opacity 0→1 animation gives a different centre pixel in each frame. The GIF starts with `GIF89a`.
- [ ] Run, expect FAIL. Implement. Run, expect PASS. Commit "feat: headless renderer (png, frame strips, gif)".

### Task 4: Studio page

**Files:** Create `studio/index.html`, `studio/app.js`, `studio/style.css`. Modify `src/server/app.ts` (serve `studio/`
at `/`). Create `test/studio.test.ts`.

What it shows:
- Board: the variants of one element in a grid, each an iframe of `/preview/element/…`. There are toggles for theme
  (light/dark/both), width (360/1280) and lang (en/sr).
- Page: an iframe of `/preview/page`.
- Motion: play/pause, 0.25× speed, and a scrubber that sets `currentTime` on all animations inside the iframe, with
  keyframe ticks.
- Feedback: clicking a tile selects it, and "Pick" posts a `pick`. Alt-click on a tile drops a pin and opens a comment
  box, posting a `comment` with x/y in tile pixels. There is a "More like this" button.
- Generate: a prompt box, a provider select, and a count of 1–4. The button label shows `Generate N · ~$X`, using
  `GET /api/gen/estimate`. Clicking it posts `/api/gen`. The spend total (today / all time) comes from
  `GET /api/spend`.
- A status strip at the top shows the lock holder and the latest status text.
- It reconnects the WS with backoff, and on `show` it switches view and selection.

The studio uses the Bringup look (the site tokens), so the tool feels like the product.

- [ ] Write a test using Playwright against `startServer` with a fixture project: the page loads. A WS `show` for element `x` makes a tile with `data-variant` appear. Clicking Pick produces a feedback item of kind `pick`.
- [ ] Run, FAIL. Implement. Run, PASS. Commit "feat: studio page (board, page, motion, feedback, generate)".

### Task 5: Tracer

**Files:** Create `src/trace/score.ts`, `src/trace/trace.ts`, `scripts/setup-tools.sh` (creates `.venv` and runs
`pip install vtracer`), `test/trace.test.ts`, and `test/fixtures/logo.png` (generated in the test from an SVG through
the renderer).

**Interfaces:**
- `scoreTrace(src:Buffer, svg:string): Promise<{iou:number, edge:number, overlay:Buffer}>`: renders the svg at the source size, binarizes each palette colour, IoU is mean over colours weighted by area, edge is the share of source edge pixels within 1 px of a trace edge, and the overlay is red/blue on grey for misses/extras. Alpha below 128 counts as background.
- `trace(src:Buffer, o:{mode:"color"|"mono", gate?:number /*0.98*/, maxIter?:number /*12*/, palette?:Record<string,string>}): Promise<{svg:string, iou:number, edge:number, overlay:Buffer, passed:boolean, iterations:number, settings:object}>`
- Search: start from vtracer `color_precision 6, filter_speckle 4, corner_threshold 60, path_precision 3`. Coordinate descent over those four (±step) keeps the best IoU, and stops at the gate or when 2 rounds bring no gain. Mono mode uses potrace with `turdSize`, `alphaMax` and `optTolerance` the same way.
- Cleanup: snap each fill to the nearest `palette` colour when ΔE < 6, drop paths below 2 px², and replace a path with
  a `<circle>` / `<rect>` when its points fit within 0.5 px.

- [ ] Write tests: a flat two-colour logo (a circle + a rect, rendered from SVG to PNG) traces with `passed:true`, `iou ≥ 0.98`, and the output contains a `<circle`. A transparent-background PNG scores the same as on white. Snapping maps `#0F5B4B` to the `--mask` value `#0E5A4A`.
- [ ] Run `bash scripts/setup-tools.sh && npx tsx --test test/trace.test.ts`. FAIL. Implement. PASS. Commit "feat: tracer with fidelity gate".

### Task 6: Generator and spend ledger

**Files:** Create `src/gen/generate.ts`, `test/gen.test.ts`. Modify `src/server/app.ts` (`/api/gen`,
`/api/gen/estimate`, `/api/spend`).

**Interfaces:**
- `PRICES: Record<string, number>`: USD per image, keyed `"<provider>:<model>:<size>"`. Starting values:
  - `openai:gpt-image-1:1024x1024`: low 0.011, medium 0.042, high 0.167 (default medium)
  - `gemini:imagen:1024x1024`: 0.04
  - `mock:*`: 0
- `estimate(req:{provider,model?,size?,quality?,count}): number`
- `generate(req & {prompt:string, refs?:Buffer[]}, deps?:{fetch?, ledgerPath?, now?}): Promise<{images:string[] /*paths under projects/<p>/refs/*/, usd:number}>`. It appends one ledger line per call.
- `spendTotals(ledgerPath): {today:number, all:number}`, counting only `source:"studio"`.
- Gemini throws `StudioError("no_key", "Add GEMINI_API_KEY to bringup-studio/.env")` when there is no key.

- [ ] Write tests: the mock writes N PNGs, and the ledger gains one line with `usd:0` and `source:"studio"`. The estimate for openai medium ×4 is 0.168. The OpenAI adapter with a stubbed fetch sends `model:"gpt-image-1"` and logs `0.042×n`. Gemini without a key gives `no_key`.
- [ ] Run, FAIL. Implement. PASS. Commit "feat: image generation with priced estimate and ledger".

### Task 7: Export to the site

**Files:** Create `src/export/site.ts`, `test/export.test.ts`. Use fixture `test/fixtures/site.html`, a trimmed copy of
the Bringup page.

**Interfaces:**
- `adopt(sitePath, o:{id:string, markupSelector:string, cssSelectors:string[]}): {diff:string, backup:string}`. It wraps
  the matched markup in `<!-- studio:<id> -->` and moves the matching CSS rules into `/* studio:<id> */…` at the end of
  the last `<style>`. It returns a unified diff and writes `<site>.bak-<timestamp>`. Token blocks are adopted with
  `id:"tokens"`.
- `exportElement(sitePath, id, {markup, css}, statePath): void`. It replaces the content inside both markers. Hashes are
  kept in `projects/<p>/export-state.json`. When the current inside-marker hash differs from the stored hash, it throws
  `StudioError("hand_edited", …, {id, current})`.
- `importBack(sitePath, id): {markup, css}`
- `applyInMemory(html, exports): string`, used by `/preview/page`.

- [ ] Write tests: adopting `.btn` moves the rule and leaves the rest of the file byte-identical apart from the markers. An export replaces only the inside of the markers. A hand edit inside a marker leads to `hand_edited` and the file is unchanged. `data-i18n` attributes survive an export.
- [ ] Run, FAIL. Implement. PASS. Commit "feat: marker-based site export with adopt and hand-edit guard".

### Task 8: MCP server

**Files:** Create `src/mcp/server.ts`, `src/mcp/open.ts`, `bin/studio-mcp` (`#!/usr/bin/env -S npx tsx`),
`test/mcp.test.ts`.

**Tools** (zod inputs; each returns text, and render/trace tools also return `image` content):
- `studio_tokens_get`, `studio_tokens_set`
- `studio_elements_list`, `studio_element_get`, `studio_element_put`
- `studio_params_set` (bulk, optional variant), `studio_variant_create`, `studio_motion_set`
- `studio_render` (element|board|page, width, theme, lang, variant; `frames:number[]` or `gif:true`)
- `studio_show`: if `/api/show` reports 0 clients, it calls `open(url)` and waits up to 5 s for a client
- `studio_feedback`: reads since its own stored cursor
- `studio_status`, `studio_lock`, `studio_unlock`
- `studio_trace` (path, mode, palette from tokens): adds an element from the svg and returns the overlay image + score
- `studio_generate`: only when the user asked in chat; the description says so
- `studio_adopt`, `studio_export`, `studio_snapshot`, `studio_restore`
- `studio_share`: writes a self-contained board HTML to a path for the Artifact tool

`ensureServer()` starts the studio server detached when `GET /api/elements` fails. The session name comes from env
`STUDIO_SESSION` or defaults to `claude-<pid>`.

- [ ] Write tests using the SDK's in-memory client transport: `tools/list` includes all of the above. `studio_render` returns `image` content. `studio_show` with 0 clients calls the injected opener once.
- [ ] Run, FAIL. Implement. PASS. Commit "feat: MCP server".

### Task 9: First project and wiring

**Files:** Create `projects/bringup/tokens.json` (the site's values verbatim), `projects/bringup/elements/{brand,btn,robot}/`,
`README.md`, `.mcp.json` example. Register with `claude mcp add --scope user bringup-studio -- /home/aleksa/Documents/3alet-hackathon/bringup-studio/bin/studio-mcp`.

- [ ] Import the tokens and the three elements from `/home/aleksa/Documents/3alet-hackathon/bringup-site/index.html`, as they are today.
- [ ] Smoke test: start the server, render each element in light and dark, and look at the PNGs.
- [ ] Run the full suite once: `npm test`, then `npx tsc --noEmit` (no pipe). Expected: all pass, 0 type errors.
- [ ] Commit "feat: bringup project, README, MCP registration".
