import { watch } from "chokidar";
import { relative, sep } from "node:path";

/** Watch a project dir; call `onChange(element?)` debounced per element (undefined = tokens/project-wide). */
export function watchProject(dir: string, onChange: (element?: string) => void, debounceMs = 50) {
  const timers = new Map<string, NodeJS.Timeout>();
  const w = watch(dir, {
    ignoreInitial: true,
    ignored: (p) => /[\\/](\.history|refs|out)([\\/]|$)/.test(p) || /feedback\.jsonl$/.test(p),
  });
  w.on("all", (_ev, path) => {
    const parts = relative(dir, path).split(sep);
    const element = parts[0] === "elements" && parts[1] ? parts[1] : undefined;
    const key = element ?? "*";
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); onChange(element); }, debounceMs));
  });
  return { close: () => w.close() };
}
