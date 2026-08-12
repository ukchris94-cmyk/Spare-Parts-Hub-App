import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNigerianPhone } from "./phoneNumbers";

test("normalizes Nigerian local and international mobile formats", () => {
  assert.equal(normalizeNigerianPhone("0801 234 5678"), "+2348012345678");
  assert.equal(normalizeNigerianPhone("+234 801 234 5678"), "+2348012345678");
});

test("rejects non-Nigerian and invalid numbers", () => {
  assert.throws(() => normalizeNigerianPhone("+1 403 555 0199"));
  assert.throws(() => normalizeNigerianPhone("12345"));
});
