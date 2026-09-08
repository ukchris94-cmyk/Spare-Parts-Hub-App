import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSpecifications, validateApplicability } from "./partApplicability";

const spec = (key: string, value = "value") => ({ key, label: key, value });

test("specifications normalize and reject duplicate keys", () => {
  assert.deepEqual(normalizeSpecifications([spec("tire_size", "205/55R16")]).items[0].value, "205/55R16");
  assert.ok(normalizeSpecifications([spec("size"), spec("size")]).error);
  assert.ok(normalizeSpecifications([{ key: "bad key", label: "Bad", value: "x" }]).error);
});

test("vehicle applicability requires exact compatibility", () => {
  assert.ok(validateApplicability({ applicabilityType: "vehicle", applicabilityProvided: true, category: "Brakes", specifications: [], compatibilityCount: 0, privileged: true }).error);
  assert.equal(validateApplicability({ applicabilityType: "vehicle", applicabilityProvided: true, category: "Brakes", specifications: [], compatibilityCount: 1, privileged: true }).status, "published");
});

test("category specifications are required and vendor submissions wait for review", () => {
  const valid = [spec("product_type"), spec("primary_standard"), spec("pack_size")];
  assert.ok(validateApplicability({ applicabilityType: "specification", applicabilityProvided: true, category: "Fluids", specifications: valid.slice(0, 2), compatibilityCount: 0, privileged: false }).error);
  assert.equal(validateApplicability({ applicabilityType: "specification", applicabilityProvided: true, category: "Fluids", specifications: valid, compatibilityCount: 0, privileged: false }).status, "pending_review");
  assert.equal(validateApplicability({ applicabilityType: "specification", applicabilityProvided: true, category: "Fluids", specifications: valid, compatibilityCount: 0, privileged: true }).status, "published");
});

test("universal products require staff publication", () => {
  assert.equal(validateApplicability({ applicabilityType: "universal", applicabilityProvided: true, category: "Other", specifications: [], compatibilityCount: 0, privileged: false }).status, "pending_review");
  assert.ok(validateApplicability({ applicabilityType: "universal", applicabilityProvided: true, category: "Other", specifications: [], compatibilityCount: 0, privileged: true }).error);
  assert.equal(validateApplicability({ applicabilityType: "universal", applicabilityProvided: true, category: "Other", specifications: [], compatibilityCount: 0, privileged: true, universalConfirmed: true, reviewNote: "No vehicle-specific fitment" }).status, "published");
});
