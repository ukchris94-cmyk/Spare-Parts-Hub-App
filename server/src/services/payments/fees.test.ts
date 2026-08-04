import assert from "node:assert/strict";
import test from "node:test";
import { calculatePaymentBreakdown } from "./fees";

test("adds the configured 7 percent purchaser fee", () => {
  assert.deepEqual(
    calculatePaymentBreakdown(100_00, { platformFeeBps: 700, taxBps: 0, currency: "ngn" }),
    {
      subtotalKobo: 100_00,
      platformFeeKobo: 700,
      taxKobo: 0,
      totalKobo: 107_00,
      currency: "NGN",
    },
  );
});

test("rounds fractional minor-unit fees upward", () => {
  const result = calculatePaymentBreakdown(101, {
    platformFeeBps: 700,
    taxBps: 750,
    currency: "NGN",
  });
  assert.equal(result.platformFeeKobo, 8);
  assert.equal(result.taxKobo, 8);
  assert.equal(result.totalKobo, 117);
});

test("rejects invalid money and basis-point inputs", () => {
  assert.throws(() =>
    calculatePaymentBreakdown(0, { platformFeeBps: 700, taxBps: 0, currency: "NGN" }),
  );
  assert.throws(() =>
    calculatePaymentBreakdown(100, { platformFeeBps: 10_001, taxBps: 0, currency: "NGN" }),
  );
});
