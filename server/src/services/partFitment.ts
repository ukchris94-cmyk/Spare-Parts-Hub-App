type PartCompatibility = { make: string; model: string; year: number; trim: string | null };
export function normalizeCompatibilities(value: unknown): {
  items: PartCompatibility[];
  error?: string;
} {
  if (value === undefined || value === null) return { items: [] };
  if (!Array.isArray(value)) {
    return { items: [], error: "compatibilities must be an array" };
  }
  if (value.length > 100) {
    return { items: [], error: "A part can have at most 100 compatible vehicles" };
  }

  const items: PartCompatibility[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return { items: [], error: "Each compatibility must be an object" };
    }
    const input = entry as Record<string, unknown>;
    const make = typeof input.make === "string" ? input.make.trim() : "";
    const model = typeof input.model === "string" ? input.model.trim() : "";
    const trim = typeof input.trim === "string" && input.trim.trim()
      ? input.trim.trim()
      : null;
    const year = typeof input.year === "number" ? input.year
      : typeof input.year === "string" && /^\d{4}$/.test(input.year.trim()) ? Number(input.year) : null;
    if (!make || !model || !year || !Number.isInteger(year) || year < 1900 || year > 2200) {
      return {
        items: [],
        error: "Each compatibility requires a valid make, model, and year",
      };
    }
    if (make.length > 80 || model.length > 100 || (trim?.length || 0) > 100) {
      return { items: [], error: "Vehicle compatibility values are too long" };
    }
    const key = `${make.toLowerCase()}|${model.toLowerCase()}|${year}|${(trim || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ make, model, year, trim });
  }
  return { items };
}

export const FITMENT_REQUIRED = "Enter at least one compatible make, model, and year before saving listing details. Existing listings without fitment can only receive price or stock updates.";
export class FitmentRequiredError extends Error {
  constructor() { super(FITMENT_REQUIRED); }
}

type Details = { name: string; description: string | null; image_url: string | null; quality: string | null };
export function requiresFitmentRepair(current: Details, changes: Partial<Details>, existingCount: number, resultingCount: number): boolean {
  if (resultingCount > 0) return false;
  if (existingCount > 0) return true;
  return (Object.keys(changes) as (keyof Details)[]).some((key) => {
    const before = typeof current[key] === "string" ? current[key]?.trim() || null : current[key];
    const after = typeof changes[key] === "string" ? changes[key]?.trim() || null : changes[key];
    return after !== before;
  });
}
