import { z } from "zod";

export class StudioError extends Error {
  constructor(public code: string, message: string, public detail?: Record<string, unknown>) {
    super(message);
    this.name = "StudioError";
  }
}

const tokenMap = z.record(z.string(), z.string());
export const TokensSchema = z.object({
  color: z.record(z.string(), z.object({ light: z.string(), dark: z.string() })),
  font: tokenMap.default({}),
  size: tokenMap.default({}),
  ease: tokenMap.default({}),
  dur: tokenMap.default({}),
});
export type Tokens = z.infer<typeof TokensSchema>;

export const ParamSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase name, letters/digits/dashes"),
  type: z.enum(["color", "length", "number", "string", "ease", "duration"]),
  value: z.union([z.string(), z.number()]),
  unit: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  note: z.string().optional(),
});
export type Param = z.infer<typeof ParamSchema>;
export const ParamsSchema = z.array(ParamSchema);

export const MotionTrackSchema = z.object({
  selector: z.string(),
  property: z.string(),
  keyframes: z.array(z.object({ offset: z.number().min(0).max(1), value: z.string(), ease: z.string().optional() })).min(2),
  duration: z.string(),
  delay: z.string().optional(),
  iterations: z.union([z.number(), z.literal("infinite")]).optional(),
});
export type MotionTrack = z.infer<typeof MotionTrackSchema>;
export const MotionSchema = z.array(MotionTrackSchema);

export const KINDS = ["logo", "button", "icon", "section", "animation", "illustration"] as const;
export const MetaSchema = z.object({ kind: z.enum(KINDS), note: z.string().optional() });

export const VariantSchema = z.record(z.string(), z.union([z.string(), z.number()]));

export type ElementDef = {
  id: string;
  kind: (typeof KINDS)[number];
  markup: string;
  css: string;
  params: Param[];
  motion: MotionTrack[];
  variants: Record<string, Record<string, string | number>>;
  note?: string;
};

export const ElementSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.enum(KINDS),
  markup: z.string(),
  css: z.string(),
  params: ParamsSchema,
  motion: MotionSchema,
  variants: z.record(z.string(), VariantSchema),
  note: z.string().optional(),
});

export type Strings = Record<string, Record<string, string>>;

/** Parse with a schema; on failure throw a StudioError naming the file and the failing field(s). */
export function parseFile<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown, file: string): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  throw new StudioError("invalid_file", `${file}: ${issues}`, { file, issues: r.error.issues });
}
