import { spawn } from "node:child_process";

/** Open a URL in the user's browser (Linux: xdg-open; macOS: open), detached. */
export async function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
    p.once("error", (e) => reject(new Error(`${cmd}: ${e.message}`)));
    p.once("spawn", () => { p.unref(); resolve(); });
  });
}
