import { createHash } from "node:crypto";
import { z } from "zod";

export const fitmentSchema = z.object({
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(100),
  year: z.number().int().min(1900).max(2200),
  trim: z.string().trim().min(1).max(100).nullable(),
}).strict();
export type Fitment = z.infer<typeof fitmentSchema>;
export const sourceSchema = z.object({
  id: z.string().min(1), name: z.string(), description: z.string().nullable(),
}).strict();
export type Source = z.infer<typeof sourceSchema>;
export const catalogSchema = z.record(z.string(), z.array(z.string()));
export type Catalog = z.infer<typeof catalogSchema>;
export const candidateSchema = z.object({
  source: sourceSchema,
  status: z.enum(["candidate", "skipped", "already-complete"]),
  proposal: fitmentSchema.nullable(), evidence: z.string(), reason: z.string(),
  requiresTrimConfirmation: z.boolean(),
}).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export const reportSchema = z.object({
  version: z.literal(1), database: z.string(), generatedAt: z.string(), catalogSha256: z.string(),
  counts: z.object({ candidate: z.number(), skipped: z.number(), alreadyComplete: z.number() }),
  entries: z.array(candidateSchema),
}).strict();
export const approvalSchema = z.object({
  reportSha256: z.string().length(64),
  reviewedBy: z.string().trim().min(1),
  backup: z.object({
    reference: z.string().trim().min(1), database: z.string(),
    restoreVerifiedAt: z.string().datetime(), verifiedBy: z.string().trim().min(1),
  }).strict(),
  candidates: z.array(z.object({
    id: z.string().min(1), confirmedTrim: z.string().trim().min(1).max(100).nullable(),
    allTrimsConfirmed: z.boolean(),
  }).strict()),
}).strict();
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function escapeRegex(value: string) { return value.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&"); }

// Deliberately accepts only a complete, standalone vehicle declaration.
export function proposeFitment(source: Source, catalog: Catalog, hasFitment = false): Candidate {
  const result: Candidate = {
    source, status: "skipped", proposal: null, evidence: "", reason: "", requiresTrimConfirmation: false,
  };
  if (hasFitment) return { ...result, status: "already-complete", reason: "Structured fitment already exists." };
  const text = source.description || "";
  if (!text.trim()) return { ...result, reason: "No description; enter verified make, model, and year." };
  if (/\b(latest|generation|universal|except|excluding|not|maybe|possibly|similar|Japanese|all models)\b/i.test(text)
      || /\b\d{4}\s*(?:[-/–]|to|through|and|&|\+)\s*\d{0,4}/i.test(text)) {
    return { ...result, reason: "Vague, excluded, or ranged compatibility requires manual review." };
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matches: { fitment: Fitment; line: string }[] = [];
  for (const [make, models] of Object.entries(catalog)) {
    for (const model of models) {
      const vehicle = escapeRegex(make) + "\\s+" + escapeRegex(model);
      const expression = new RegExp("^(?:(?:fits|fitment|compatible with)\\s*:?\\s*)?(?:(\\d{4})\\s+" + vehicle + "|" + vehicle + "\\s+(\\d{4}))(?:\\s*[-,:]?\\s*(all trims))?[.]?$", "i");
      for (const line of lines) {
        const match = expression.exec(line);
        if (!match) continue;
        const parsed = fitmentSchema.safeParse({ make, model, year: Number(match[1] || match[2]), trim: null });
        if (parsed.success) matches.push({ fitment: parsed.data, line });
      }
    }
  }
  if (matches.length !== 1) return { ...result, reason: "Expected one unambiguous standalone make/model/year declaration." };
  const match = matches[0];
  // Additional references could represent exclusions or conflicting compatibility.
  const brandMetadata = new RegExp("^Brand:\\s*" + escapeRegex(match.fitment.make)
    + "\\s+Genuine Parts(?:\\s*\\u00b7\\s*Category:\\s*[A-Za-z /&-]+)?$", "i");
  const remaining = lines.filter((line) => line !== match.line && !brandMetadata.test(line)).join(" ");
  const mentionsMake = Object.keys(catalog).some((make) =>
    new RegExp("\\b" + escapeRegex(make) + "\\b", "i").test(remaining));
  const mentionsModel = Object.values(catalog).flat().some((model) =>
    new RegExp("\\b" + escapeRegex(model) + "\\b", "i").test(remaining));
  if (mentionsMake || mentionsModel || /\b(?:19|20|21)\d{2}\b/.test(remaining)) {
    return { ...result, reason: "Additional vehicle, model, or year text requires manual review." };
  }
  return {
    ...result, status: "candidate", proposal: match.fitment, evidence: match.line,
    requiresTrimConfirmation: !/\ball trims\b/i.test(match.line),
    reason: /\ball trims\b/i.test(match.line)
      ? "Explicit vehicle/year/all-trims declaration; review before approval."
      : "Explicit vehicle/year declaration; reviewer must verify trim applicability.",
  };
}
