import assert from "node:assert/strict";
import test from "node:test";
import { assertGeocodeStatus, autocompletePlaces, GoogleMapsServiceError } from "./googleMaps";

test("Places reports a blocked server key as configuration failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GOOGLE_MAPS_SERVER_API_KEY;
  try {
    process.env.GOOGLE_MAPS_SERVER_API_KEY = "test-only-key";
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { status: "PERMISSION_DENIED", message: "Requests from referer <empty> are blocked." },
    }), { status: 403, headers: { "Content-Type": "application/json" } });
    await assert.rejects(
      autocompletePlaces("Port Harcourt"),
      (error: unknown) => error instanceof GoogleMapsServiceError
        && error.code === "GOOGLE_MAPS_CONFIGURATION_ERROR"
        && error.statusCode === 503,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_SERVER_API_KEY;
    else process.env.GOOGLE_MAPS_SERVER_API_KEY = originalKey;
  }
});

test("geocoding distinguishes no results from a blocked server key", () => {
  assert.doesNotThrow(() => assertGeocodeStatus({ status: "OK" }));
  assert.doesNotThrow(() => assertGeocodeStatus({ status: "ZERO_RESULTS" }));
  assert.throws(
    () => assertGeocodeStatus({ status: "REQUEST_DENIED" }),
    (error: unknown) => error instanceof GoogleMapsServiceError
      && error.code === "GOOGLE_MAPS_CONFIGURATION_ERROR"
      && error.statusCode === 503,
  );
});

test("geocoding reports quota failures separately", () => {
  assert.throws(
    () => assertGeocodeStatus({ status: "OVER_QUERY_LIMIT" }),
    (error: unknown) => error instanceof GoogleMapsServiceError
      && error.code === "GOOGLE_MAPS_RATE_LIMITED"
      && error.statusCode === 429,
  );
});
