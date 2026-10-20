import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import partsRouter from "./parts";
import * as database from "../db";
import { env } from "../config/env";

function accessToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    sid: randomUUID(),
    ver: 0,
    iat: now,
    exp: now + 900,
  })).toString("base64url");
  const signature = createHmac(
    "sha256",
    env.AUTH_TOKEN_SECRET || "quickserve-development-access-token-secret",
  ).update(payload).digest("base64url");
  return `v2.${payload}.${signature}`;
}

async function getSummary(token?: string): Promise<{ status: number; body: any }> {
  const app = express();
  app.use("/api/parts", partsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/parts/vendor-summary?userId=other_vendor`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("vendor summary counts the full inventory and ignores a supplied vendor ID", async () => {
  const db = database as { query: typeof database.query };
  const original = db.query;
  const vendorId = "usr_test_vendor";
  const queriedVendorIds: unknown[] = [];
  try {
    db.query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM users u")) return { rows: [{ id: vendorId, role: "vendor" }] };
      if (sql.includes("FROM parts")) {
        queriedVendorIds.push(params?.[0]);
        if (sql.includes("COUNT(*)::int")) {
          return { rows: [{ total_items: 370, inventory_value: "1828990000", low_stock_count: 7 }] };
        }
        return { rows: [] };
      }
      throw new Error("Unexpected query in vendor summary test");
    }) as unknown as typeof database.query;

    const result = await getSummary(accessToken(vendorId));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.stats, {
      totalItems: 370,
      inventoryValue: 1828990000,
      lowStockCount: 7,
    });
    assert.deepEqual(queriedVendorIds, [vendorId, vendorId, vendorId]);
  } finally {
    db.query = original;
  }
});

test("vendor summary requires an authenticated vendor", async () => {
  assert.equal((await getSummary()).status, 401);
  const db = database as { query: typeof database.query };
  const original = db.query;
  try {
    db.query = (async () => ({ rows: [{ id: "usr_admin", role: "admin" }] })) as unknown as typeof database.query;
    assert.equal((await getSummary(accessToken("usr_admin"))).status, 403);
  } finally {
    db.query = original;
  }
});
