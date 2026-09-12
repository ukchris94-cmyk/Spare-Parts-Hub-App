export type ApplicabilityType = "vehicle" | "specification" | "universal";
export type ListingStatus = "published" | "pending_review";
export type PartSpecification = { key: string; label: string; value: string };
export type BroadCompatibility = {
  scope: "selected_makes" | "all_makes";
  vehicleMakes: string[];
  yearScope: "all_years" | "year_range";
  yearFrom: number | null;
  yearTo: number | null;
};

const TYPES = new Set<ApplicabilityType>(["vehicle", "specification", "universal"]);
const VEHICLE_MAKES = [
  "Acura", "Alfa Romeo", "Aston Martin", "Audi", "BMW", "BYD", "Bentley", "Buick", "Cadillac",
  "Changan", "Chery", "Chevrolet", "Chrysler", "Daewoo", "Daihatsu", "Dodge", "Ferrari", "Fiat",
  "Ford", "GAC", "GMC", "Geely", "Genesis", "Honda", "Hummer", "Hyundai", "Infiniti", "Isuzu",
  "Jaguar", "Jeep", "Kia", "Lamborghini", "Land Rover", "Lexus", "Lincoln", "Maserati", "Mazda",
  "Mercedes-Benz", "Mercury", "Mini", "Mitsubishi", "Nissan", "Opel", "Peugeot", "Porsche",
  "Renault", "Rolls-Royce", "Saab", "Saturn", "Smart", "Subaru", "Suzuki", "Tesla", "Toyota",
  "Volkswagen", "Volvo",
] as const;
const CANONICAL_VEHICLE_MAKES = new Map(VEHICLE_MAKES.map((make) => [make.toLowerCase(), make]));
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

export function normalizeBroadCompatibility(value: unknown): { item: BroadCompatibility | null; error?: string } {
  if (value === undefined || value === null) return { item: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { item: null, error: "Broad compatibility must be an object" };
  }
  const row = value as Record<string, unknown>;
  const scope = row.scope === "selected_makes" || row.scope === "all_makes" ? row.scope : null;
  const yearScope = row.yearScope === "all_years" || row.yearScope === "year_range" ? row.yearScope : null;
  if (!scope) return { item: null, error: "Choose selected vehicle makes or all vehicle makes" };
  if (!yearScope) return { item: null, error: "Choose all years or a year range" };
  if (!Array.isArray(row.vehicleMakes)) return { item: null, error: "Vehicle makes must be an array" };

  const makes: string[] = [];
  const seen = new Set<string>();
  for (const rawMake of row.vehicleMakes) {
    if (typeof rawMake !== "string") return { item: null, error: "Each vehicle make must be text" };
    const submittedMake = rawMake.trim();
    const key = submittedMake.toLowerCase();
    const make = CANONICAL_VEHICLE_MAKES.get(key);
    if (!make) return { item: null, error: `${submittedMake || "Vehicle make"} is not in the vehicle catalog` };
    if (!seen.has(key)) {
      seen.add(key);
      makes.push(make);
    }
  }
  if (makes.length > 20) return { item: null, error: "Select no more than 20 vehicle makes" };

  const yearFrom = typeof row.yearFrom === "number" && Number.isInteger(row.yearFrom) ? row.yearFrom : null;
  const yearTo = typeof row.yearTo === "number" && Number.isInteger(row.yearTo) ? row.yearTo : null;
  const maximumYear = new Date().getFullYear() + 1;
  if (scope === "all_makes") {
    if (makes.length || yearScope !== "all_years" || yearFrom !== null || yearTo !== null) {
      return { item: null, error: "All vehicle makes must use all years without individual make selections" };
    }
    return { item: { scope, vehicleMakes: [], yearScope: "all_years", yearFrom: null, yearTo: null } };
  }
  if (!makes.length) return { item: null, error: "Select at least one vehicle make" };
  if (yearScope === "all_years") {
    if (yearFrom !== null || yearTo !== null) return { item: null, error: "All years cannot include a year range" };
    return { item: { scope, vehicleMakes: makes, yearScope, yearFrom: null, yearTo: null } };
  }
  if (yearFrom === null || yearTo === null) return { item: null, error: "Enter both the first and last compatible year" };
  if (yearFrom < 1980 || yearTo > maximumYear || yearFrom > yearTo) {
    return { item: null, error: `Choose a valid year range between 1980 and ${maximumYear}` };
  }
  return { item: { scope, vehicleMakes: makes, yearScope, yearFrom, yearTo } };
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
  broadCompatibility?: BroadCompatibility | null;
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
    if (!input.broadCompatibility) {
      return { status: privileged ? "published" : "pending_review", error: "Choose the vehicle makes and year coverage for Broad compatibility" };
    }
    if (!input.reviewNote) {
      return { status: privileged ? "published" : "pending_review", error: "Add a Broad compatibility explanation" };
    }
    if (!privileged) return { status: "pending_review" };
    if (!input.universalConfirmed) {
      return { status: "published", error: "Confirm Broad compatibility" };
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
  return ["name", "description", "imageUrl", "category", "brand", "manufacturerPartNumber", "applicabilityType", "specifications", "compatibilities", "broadCompatibility"]
    .some((key) => Object.prototype.hasOwnProperty.call(changes, key));
}
