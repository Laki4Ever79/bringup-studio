import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STUDIO_ROOT } from "../server/app.ts";
import { createMcp } from "./server.ts";
import { openBrowser } from "./open.ts";

const port = Number(process.env.STUDIO_PORT ?? 4747);
const base = `http://127.0.0.1:${port}`;
const out = join(STUDIO_ROOT, "out");
mkdirSync(out, { recursive: true });

async function up(): Promise<boolean> {
  try { return (await fetch(base + "/api/state")).ok; } catch { return false; }
}

/** Start the studio server detached (it outlives this MCP process and is shared by every session). */
async function ensureServer() {
  if (await up()) return;
  const log = openSync(join(out, "server.log"), "a");
  const p = spawn(process.execPath, ["--import", "tsx", join(STUDIO_ROOT, "src/server/main.ts")], {
    cwd: STUDIO_ROOT, detached: true, stdio: ["ignore", log, log], env: { ...process.env, STUDIO_PORT: String(port) },
  });
  p.unref();
  for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
}

await ensureServer();
const session = process.env.STUDIO_SESSION ?? `claude-${process.ppid}`;
const server = createMcp({ base, session, open: openBrowser, cursorDir: out, shareDir: join(out, "share") });
await server.connect(new StdioServerTransport());
