import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { parseFile } from "../model/types.ts";

export const FeedbackInSchema = z.object({
  kind: z.enum(["pick", "comment", "more", "generate"]),
  element: z.string().optional(),
  variant: z.string().optional(),
  view: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  text: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type FeedbackIn = z.infer<typeof FeedbackInSchema>;
export type Feedback = FeedbackIn & { at: string; seq: number };

export class FeedbackLog {
  constructor(private path: string) {}

  all(): Feedback[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  add(input: unknown): Feedback {
    const f = parseFile(FeedbackInSchema, input, "feedback");
    const item: Feedback = { ...f, at: new Date().toISOString(), seq: this.all().length };
    appendFileSync(this.path, JSON.stringify(item) + "\n");
    return item;
  }

  since(n: number): { items: Feedback[]; cursor: number } {
    const all = this.all();
    return { items: all.slice(Math.max(0, n)), cursor: all.length };
  }
}
