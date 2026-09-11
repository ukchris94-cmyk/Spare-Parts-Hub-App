import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCompatibilities, requiresFitmentRepair } from "./partFitment";
import { proposeFitment, approvalSchema, reportSchema } from "./fitmentBackfill";

const details = { name: "ABS sensor", description: "Toyota Camry 2014", image_url: null, quality: null };
const fitment = { make: "Toyota", model: "Camry", year: 2014, trim: null };
test("normalization rejects malformed years and incomplete vehicles", () => {
  for (const year of [2014.5, "2014junk", "2014.5", null, 1800, 2201]) {
    assert.ok(normalizeCompatibilities([{ ...fitment, year }]).error);
  }
  assert.ok(normalizeCompatibilities([{ make: "Toyota", year: 2014 }]).error);
  assert.ok(normalizeCompatibilities({}).error);
  assert.ok(normalizeCompatibilities(Array(101).fill(fitment)).error);
});
test("normalization preserves valid fitment and deduplicates case/space", () => {
  assert.deepEqual(normalizeCompatibilities([fitment, { ...fitment, make: " toyota ", year: "2014", trim: "" }]).items, [fitment]);
});
test("legacy full payload permits only effectively unchanged details", () => {
  assert.equal(requiresFitmentRepair(details, { ...details, name: " ABS sensor ", description: "Toyota Camry 2014 " }, 0, 0), false);
  assert.equal(requiresFitmentRepair(details, {}, 0, 0), false);
  for (const change of [{ name: "Different" }, { description: "Other" }, { quality: "good" }, { image_url: "new.jpg" }]) {
    assert.equal(requiresFitmentRepair(details, change, 0, 0), true);
    assert.equal(requiresFitmentRepair(details, change, 0, 1), false);
  }
});
test("cannot clear previously completed fitment", () => {
  assert.equal(requiresFitmentRepair(details, {}, 1, 0), true);
  assert.equal(requiresFitmentRepair(details, {}, 1, 1), false);
});
const catalog = { Toyota: ["Camry", "Hilux"], Honda: ["Accord"] };
const source = (description: string, applicabilityType: "vehicle" | "specification" | "universal" | null = null) => ({
  id: "p1",
  name: "Sensor",
  description,
  userId: "vendor-1",
  vendorName: "Vendor One",
  category: null,
  applicabilityType,
});
const propose = (description: string) => proposeFitment(source(description), catalog);
test("standalone exact declarations propose evidence but require trim review", () => {
  const candidate = propose("Toyota Camry 2014\nPair\nFront");
  assert.equal(candidate.status, "candidate");
  assert.deepEqual(candidate.proposal, fitment);
  assert.equal(candidate.evidence, "Toyota Camry 2014");
  assert.equal(candidate.requiresTrimConfirmation, true);
  assert.equal(propose("2014 Toyota Camry - all trims").requiresTrimConfirmation, false);
  assert.equal(propose("Toyota Camry 2014\nPair\nFront\nBrand: Toyota Genuine Parts").status, "candidate");
});
test("vague, conflicting, misleading, and missing details are skipped", () => {
  for (const description of [
    "", "Toyota Camry", "Toyota Hilux Latest Model", "Toyota Camry 2012-2014",
    "Toyota Camry 2014\nExcept SE", "Toyota Camry 2014\nHonda Accord 2014",
    "Brand: Toyota Genuine Parts 2014", "Toyota Camry 2014\nAlso Accord",
    "Toyota Camry 2014\nModel year 2015", "Toyota Camry 2014 SE", "Toyota Camry 2014/15",
  ]) assert.equal(propose(description).status, "skipped", description);
});
test("existing compatibility is never proposed for overwrite", () => {
  assert.equal(proposeFitment({ ...source("Toyota Camry 2014"), id: "p" }, catalog, true).status, "already-complete");
  assert.equal(proposeFitment(source("Toyota Camry 2014", "specification"), catalog).status, "already-complete");
  assert.equal(proposeFitment(source("Toyota Camry 2014", "universal"), catalog).status, "already-complete");
});
test("explicit specification values are advisory only", () => {
  const candidate = propose("Engine oil 5W-30, 4L");
  assert.equal(candidate.status, "skipped");
  assert.deepEqual(candidate.advisorySpecifications.map((item) => [item.key, item.value]), [
    ["grade_viscosity", "5W-30"],
    ["pack_size", "4L"],
    ["product_type", "Engine oil"],
  ]);
});
test("approval and audit schemas reject incomplete safety metadata", () => {
  assert.equal(approvalSchema.safeParse({ candidates: [{ id: "p1" }] }).success, false);
  assert.equal(reportSchema.safeParse({ entries: [propose("Toyota Camry 2014")] }).success, false);
  const completeReport = {
    version: 2,
    database: "fingerprint",
    generatedAt: new Date().toISOString(),
    catalogSha256: "a".repeat(64),
    counts: { candidate: 1, skipped: 0, alreadyComplete: 0 },
    entries: [propose("Toyota Camry 2014")],
  };
  assert.equal(reportSchema.safeParse(completeReport).success, true);
  assert.equal(reportSchema.safeParse({ ...completeReport, version: 1 }).success, false);
});
