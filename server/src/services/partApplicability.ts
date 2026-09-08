export type ApplicabilityType = "vehicle" | "specification" | "universal";
export type ListingStatus = "published" | "pending_review";
export type PartSpecification = { key: string; label: string; value: string };

const TYPES = new Set<ApplicabilityType>(["vehicle", "specification", "universal"]);
const SPECIFICATION_REQUIREMENTS: Record<string, string[][]> = {
  fluids: [["product_type"], ["primary_standard", "grade_viscosity"], ["pack_size"]],
  tires: [["tire_size", "size"]],
  batteries: [["battery_code_size", "size"]],
  lighting: [["bulb_socket_type", "socket_type"]],
  filters: [["part_number", "cross_reference_number"]],
};

function cleanText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

export function normalizeApplicabilityType(value: unknown): ApplicabilityType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase() as ApplicabilityType;
  return TYPES.has(normalized) ? normalized : null;
}

export function normalizePartMetadata(input: {
  category?: unknown;
  brand?: unknown;
  manufacturerPartNumber?: unknown;
  applicabilityReviewNote?: unknown;
}) {
  return {
    category: cleanText(input.category, 80),
    brand: cleanText(input.brand, 120),
    manufacturerPartNumber: cleanText(input.manufacturerPartNumber, 120),
    applicabilityReviewNote: cleanText(input.applicabilityReviewNote, 500),
  };
}

export function normalizeSpecifications(value: unknown): { items: PartSpecification[]; error?: string } {
  if (value === undefined || value === null) return { items: [] };
  if (!Array.isArray(value)) return { items: [], error: "specifications must be an array" };
  if (value.length > 20) return { items: [], error: "A listing can have at most 20 specifications" };
  const items: PartSpecification[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return { items: [], error: "Each specification must be an object" };
    const row = raw as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim().toLowerCase() : "";
    const label = typeof row.label === "string" ? row.label.trim() : "";
    const specificationValue = typeof row.value === "string" ? row.value.trim() : "";
    if (!/^[a-z0-9_]{1,60}$/.test(key) || !label || label.length > 80 || !specificationValue || specificationValue.length > 200) {
      return { items: [], error: "Each specification requires a valid key, label, and value" };
    }
    if (seen.has(key)) return { items: [], error: `Specification ${label} is duplicated` };
    seen.add(key);
    items.push({ key, label, value: specificationValue });
  }
  return { items };
}

export function validateApplicability(input: {
  applicabilityType: ApplicabilityType | null;
  applicabilityProvided: boolean;
  category: string | null;
  specifications: PartSpecification[];
  compatibilityCount: number;
  privileged: boolean;
  reviewNote?: string | null;
  universalConfirmed?: boolean;
  existing?: boolean;
}): { error?: string; status: ListingStatus } {
  const { applicabilityType, category, specifications, compatibilityCount, privileged } = input;
  if (!applicabilityType) {
    return input.existing && !input.applicabilityProvided
      ? { status: "published" }
      : { status: "published", error: "Choose how this product is matched to a vehicle" };
  }
  if (applicabilityType === "vehicle") {
    return compatibilityCount > 0
      ? { status: "published" }
      : { status: "published", error: "Enter at least one compatible make, model, and year" };
  }
  if (compatibilityCount > 0) {
    return { status: "published", error: "Vehicle rows can only be used with Exact vehicle" };
  }
  if (applicabilityType === "universal") {
    if (!privileged) return { status: "pending_review" };
    if (!input.universalConfirmed || !input.reviewNote) {
      return { status: "published", error: "Confirm universal applicability and add a compatibility note" };
    }
    return { status: "published" };
  }
  const keys = new Set(specifications.map((item) => item.key));
  const requirements = SPECIFICATION_REQUIREMENTS[(category || "").toLowerCase()] || [["matching_specification"]];
  const missing = requirements.find((alternatives) => !alternatives.some((key) => keys.has(key)));
  if (missing) {
    return { status: privileged ? "published" : "pending_review", error: `Add the required ${missing[0].replace(/_/g, " ")} specification` };
  }
  return { status: privileged ? "published" : "pending_review" };
}

export function affectsReviewedApplicability(changes: Record<string, unknown>): boolean {
  return ["name", "description", "imageUrl", "category", "brand", "manufacturerPartNumber", "applicabilityType", "specifications", "compatibilities"]
    .some((key) => Object.prototype.hasOwnProperty.call(changes, key));
}
