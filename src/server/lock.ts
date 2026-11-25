import { StudioError } from "../model/types.ts";

/** Single-writer lock. The holder's lock refreshes on every write and expires after `ttlMs` idle. */
export class Lock {
  holder: string | null = null;
  private last = 0;
  constructor(private ttlMs = 10 * 60_000, private now = () => Date.now()) {}

  current(): string | null {
    if (this.holder && this.now() - this.last > this.ttlMs) this.holder = null;
    return this.holder;
  }

  acquire(session: string): void {
    const h = this.current();
    if (h && h !== session) throw new StudioError("locked", `project is locked by "${h}"`, { holder: h });
    this.holder = session;
    this.last = this.now();
  }

  /** Called before every write: auto-acquires when free, refuses when another session holds it. */
  check(session: string | undefined): void {
    if (!session) throw new StudioError("no_session", "writes need an x-studio-session header naming the session");
    this.acquire(session);
  }

  release(session: string): void {
    if (this.current() === session) this.holder = null;
  }
}
