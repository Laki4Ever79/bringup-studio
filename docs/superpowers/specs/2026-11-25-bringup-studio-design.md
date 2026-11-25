# Bringup Studio: design

Date: 25 Nov 2026. Status: draft for approval.

## Intent

A Figma replacement built for an agent. Claude does nearly all the design work (logos, buttons, UI elements,
animations) through an MCP server. The user mostly **judges** what Claude shows them, and sometimes suggests or pulls in
example images from Gemini or OpenAI. First job: design and tune the Bringup waitlist page
(`/home/aleksa/Documents/3alet-hackathon/bringup-site/index.html`).

The user's own words set the bar:
- "a mechanism to quickly and reliably show me drafts and final results"
- "customize the minutest details of elements and animations"
- "quickly suggest things or generate examples via gemini, openai or whatever"
- "trace images perfectly", as an included tool

## Goals
1. **Show fast and reliably.** Every change Claude makes is on the user's screen within about a second, and nothing
   arrives broken: Claude has already rendered and looked at it before announcing it.
2. **Exact control.** Every visual value (a colour, a stroke width, a corner radius, a keyframe offset, an easing curve,
   a duration) is a named, editable value in a plain file. There are no opaque blobs.
3. **A quick channel from the user.** Pick a variant, leave a comment pinned to a spot, ask for N alternatives, generate
   a reference image. All of it reaches Claude through MCP.
4. **Tracing as close to perfect as the source allows.** Raster in, clean SVG out, with a measured fidelity score.
5. **Output that drops into the page.** Plain inline SVG and CSS (plus vanilla JS only where CSS can't do it), so the
   static site keeps no runtime dependency.

## Non-goals
- A canvas where the user drags and draws (they said they'd mostly judge).
- Multi-user collaboration, accounts, or cloud hosting.
- A general Figma file format, or import from Figma/Penpot.
- Video production (HyperFrames already covers that).

## Anti-goals (a failure even if it works)
- Showing the user something Claude hasn't rendered and checked itself.
- Spending money on image generation the user didn't ask for, or spending it without logging it.
- Fine control so buried that changing one value takes Claude more than one tool call.
- Exports that pull a framework or animation library into the site.

## Constraints
- Local Linux laptop. Node 24 is installed, and Docker is available. No sudo, so tools are installed into the project
  folder (Python tools into `.venv/`, binaries into `tools/`), never system-wide.
- Lives in its own folder, `/home/aleksa/Documents/3alet-hackathon/bringup-studio`, as its own git repo, separate from
  agent-mesh.
- Money rule (user's motto): paid generation runs only on an explicit request, one at a time, each logged to the
  existing ledger `~/.bringup/spend.jsonl`. Keys: `OPENAI_API_KEY` exists in agent-mesh's `.env`. There is no Gemini key
  yet, so that adapter stays dormant until one is added.
- The site's existing design tokens are the starting design system: `--paper`, `--ink`, `--muted`, `--line`, `--mask`,
  `--mask-ink`, `--copper`, `--panel`, plus the fonts Bricolage Grotesque, IBM Plex Sans and IBM Plex Mono, in light
  and dark.

## Approaches considered
- **A. MCP server + local studio page + headless renders (chosen).** Elements are files of SVG, CSS and parameters. A
  local web studio live-reloads, shows variants side by side, scrubs animations, and collects picks and comments.
  Playwright renders the same frames for Claude to check. Picked by the user because the studio itself is the quick,
  reliable way to show drafts, and claude.ai Artifact sharing can still be layered on top.
- B. Same core, reviewed through claude.ai Artifact pages. It works from a phone, but each draft needs a publish round
  trip, which is too slow for back-and-forth. It is kept only as an optional "share this" export.
- C. No tool: ad-hoc scripts plus HyperFrames. Least work, but there is no single place to see and pick drafts, so it
  fails goal 1.

## Design

### Parts
1. **Project store** (plain files in the studio repo, under `projects/<name>/`):
   - `tokens.json`: colours (light and dark), fonts, spacing, radii, easing curves, durations. Exported as CSS custom
     properties.
   - `elements/<id>/`: one folder per element (logo, button, icon, section, animation):
     - `element.svg` and/or `element.html`: markup that refers to tokens and parameters
     - `style.css`
     - `params.json`: every tunable value of this element, with name, type, unit and range
     - `motion.json`: optional; timeline tracks (target selector, property, keyframes with offset, value and easing)
       that compile to CSS `@keyframes` (Web Animations API only where CSS can't express it)
     - `variants/<vid>.json`: a variant is a parameter override on top of `params.json`, so variants stay cheap and
       diffable
   - `history/`: every save is a git commit made by the studio, so any earlier draft can be restored by name.
   - `feedback.jsonl`: the user's picks and comments.
2. **Studio server** (Node/TypeScript, a single process): serves the studio page, watches the files, pushes reloads over
   WebSocket, and exposes an HTTP API that the MCP server and the studio page share. It also runs the renderer.
3. **Studio page** (what the user sees in the browser):
   - Board view: an element's variants in a grid, each labelled. Light and dark, plus phone and desktop widths, can be
     toggled.
   - Page view: the real Bringup page with the studio's current exports injected, so elements are judged in place.
   - Motion view: play, pause, slow-motion, and a scrubber with keyframe markers.
   - Feedback: click a variant to pick it. Click anywhere to drop a pinned comment (stored with the element id,
     variant, and x/y). A "more like this" button and a "generate reference" box (prompt plus provider) are also here.
   - A "Claude is working on…" strip at the top, so the user knows when a draft is coming.
4. **MCP server** (stdio, `@modelcontextprotocol/sdk`). It talks to the studio server. Tools (names are the builder's
   call; the capabilities are fixed):
   - Tokens: read and set
   - Elements: create, read, write markup/CSS, set one or many params, add or remove motion keyframes, create variants
     from param sets
   - **Render**: PNG of an element, variant, board or page at a given width and theme, returned to Claude as an image.
     Animations come back as a frame strip (N frames at chosen times) or a GIF.
   - **Show**: focuses the user's studio on a board/variant set, with a one-line note. This is the "draft is ready"
     signal.
   - **Feedback**: read new picks and comments since the last read.
   - **Trace**: see below.
   - **Generate**: see below.
   - **Export**: writes the chosen variant's SVG, CSS and tokens into the site (see Export).
   - **Snapshot / restore**: name the current state, and go back to it.
   - **Share**: optionally builds a self-contained HTML page of a board for publishing as a claude.ai Artifact (for
     viewing on the phone).
5. **Tracer.** Main input (user's decision): **flat logos and icons**. For these, "perfect" is a gate: pixel IoU
   ≥ 0.98, otherwise the trace isn't done. Gradients, photos and AI art get a best-effort trace with a report of where
   it differs. Gradient fills are out of scope for now.
   - Engines: vtracer (colour, Python wheel in `.venv`) and potrace (monochrome).
   - Loop: trace, render the SVG at the source size, then compare with the source. The score is pixel IoU per colour
     region plus an edge-distance score. Tune the engine settings (colour precision, corner threshold, path precision,
     speckle filter) and repeat until the score passes a threshold or stops improving.
   - Cleanup: merge near-duplicate colours to the nearest token where the user wants brand colours, drop sub-pixel
     specks, simplify paths, snap near-straight lines and near-circles to true primitives.
   - Returns the SVG, the score, and a source / trace / difference overlay image so both Claude and the user can see
     where it deviates.
6. **Generator.**
   - Adapters: OpenAI Images (key present) and Gemini (dormant until a key is added). One interface: prompt, optional
     reference images, size, count.
   - Runs only when the user asks. In the studio, the Generate button shows the estimated price
     ("Generate 4 · ~$0.16"), and **clicking it is the approval**. Claude may also generate when the user asks in chat.
     **No image cap** (user's decision), but every call is tracked: each one appends to `~/.bringup/spend.jsonl` in the
     existing entry shape `{at, usd, model, source, where}`, with `source: "studio"`. The studio shows a running total
     of image spending (today, and all time). A small price table per model/size feeds both the estimate and the logged
     `usd`.
   - Results land as **reference images** on the board, never as final elements. Claude traces or redraws them.
7. **Export to the site.** The site is one `index.html`, not in git (Claude's calls below).
   - **Adopt step, once per element.** The page has no markers today. Its tokens sit in three blocks (`:root`,
     `prefers-color-scheme`, `[data-theme="dark"]`), and element rules (`.btn`, `.brand`, `.robot …`) sit in the shared
     `<style>`. A one-time "adopt" moves each element's existing rules into a marked section of `<style>`
     (`/* studio:<id> */ … /* /studio:<id> */`), and wraps its markup in place
     (`<!-- studio:<id> -->…<!-- /studio:<id> -->`). The token blocks are wrapped as `studio:tokens`.
   - Adopt writes a backup first and shows the user the diff. It is the only time export edits outside markers.
   - **After that, export only splices inside markers.**
   - **Ownership.** The studio owns what's inside markers, and the page owns everything else (copy, form URL, scripts).
     Export stores a hash of what it last wrote. If the content inside a marker changed by hand, export refuses and
     offers to import that change back into the element. Restoring a studio snapshot does not touch the site until the
     next export.
   - **i18n.** Exported markup keeps the `data-i18n` keys. Text is an element parameter. Boards have a language axis
     (EN and SR, read from the page's string table), so widths are judged in both languages.

### Sessions and viewing (Claude's calls)
- **One writer per project.** A session takes a lock and names itself; the "working on…" strip shows that name.
  Other sessions can read and render, but not write, until the lock is released. A stale lock expires.
- **Show opens the studio** in the browser if no tab is connected, and focuses it otherwise.
- The server binds to localhost only. Viewing on the phone goes through Share (a claude.ai Artifact), not the LAN.

### Workflow, end to end
1. Claude edits files through MCP, then renders and looks at the result itself, and fixes it if it's off.
2. Claude calls **Show**, and the studio jumps there. The user looks, picks or comments.
3. Claude reads feedback, iterates, and repeats.
4. A chosen variant is exported to the page, the Page view shows it in place, and it gets a snapshot.

### First job: the Bringup page
- Import the page's tokens into `tokens.json`. Wrap the existing robot SVG, the buttons and the brand mark as elements.
- Then tune them with the user: logo, buttons (states: rest, hover, focus, pressed, disabled), the robot illustration,
  and an entrance animation.

## Left to the builder
- Folder layout inside the repo, exact tool names and argument shapes, and the HTTP routes.
- Frontend stack for the studio page (plain TS and DOM is enough; a small framework only if it clearly pays).
- The fidelity threshold and scoring weights for tracing (start at IoU ≥ 0.98 and tune on test images).
- GIF encoder choice and the default number of frames in a strip.
- The port, and how the studio server is started (the MCP server may start it on demand).
- Tests: targeted unit tests on the parameter/motion compiler, the export markers and the trace scorer, plus one
  end-to-end smoke test (create an element, render it, show it, read a pick). No paid calls in tests; the generator gets
  a mock adapter.
