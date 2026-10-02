import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import authRouter from "./auth";
import * as database from "../db";
import { hashPassword } from "../services/passwords";

type JsonBody = Record<string, unknown>;

async function postLogin(body: JsonBody): Promise<{ status: number; body: JsonBody }> {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as JsonBody };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function mockUser(passwordHash: string, verified = true) {
  return {
    id: "usr_test", first_name: "Test", last_name: "User", email: "test@example.com",
    phone_e164: null, business_name: null, role: "admin", verified,
    phone_verified_at: null, password_hash: passwordHash,
  };
}

test("login rejects malformed requests before reaching the database", async () => {
  const result = await postLogin({ password: "example-password" });
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
});

test("login returns 401 for an unknown account and wrong password", async () => {
  const db = database as { query: typeof database.query };
  const original = db.query;
  try {
    db.query = (async () => ({ rows: [] })) as unknown as typeof database.query;
    const unknown = await postLogin({ identifier: "test@example.com", password: "wrong-password" });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.message, "Invalid login credentials");

    const passwordHash = await hashPassword("correct-password");
    db.query = (async () => ({ rows: [mockUser(passwordHash)] })) as unknown as typeof database.query;
    const wrongPassword = await postLogin({ identifier: "test@example.com", password: "wrong-password" });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.body.message, "Invalid login credentials");
  } finally {
    db.query = original;
  }
});

test("login requests email verification for an unverified account", async () => {
  const db = database as { query: typeof database.query };
  const original = db.query;
  try {
    const passwordHash = await hashPassword("correct-password");
    db.query = (async () => ({ rows: [mockUser(passwordHash, false)] })) as unknown as typeof database.query;
    const result = await postLogin({ identifier: "test@example.com", password: "correct-password" });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "EMAIL_VERIFICATION_REQUIRED");
  } finally {
    db.query = original;
  }
});

test("successful login issues both token types and a complete session", async () => {
  const db = database as { query: typeof database.query; pool: typeof database.pool };
  const originalQuery = db.query;
  const originalConnect = db.pool.connect;
  const passwordHash = await hashPassword("correct-password");
  let sessionInserted = false;
  const client = {
    query: async (sql: string) => {
      if (sql.includes("SELECT token_version")) return { rows: [{ token_version: 0 }] };
      if (sql.includes("INSERT INTO auth_sessions")) sessionInserted = true;
      return { rows: [] };
    },
    release: () => undefined,
  };
  try {
    db.query = (async () => ({ rows: [mockUser(passwordHash)] })) as unknown as typeof database.query;
    db.pool.connect = (async () => client) as typeof database.pool.connect;
    const result = await postLogin({ identifier: "test@example.com", password: "correct-password" });
    assert.equal(result.status, 200);
    assert.equal(result.body.userId, "usr_test");
    assert.match(String(result.body.accessToken), /^v2\./);
    assert.match(String(result.body.refreshToken), /^r1\./);
    assert.equal(sessionInserted, true);
  } finally {
    db.query = originalQuery;
    db.pool.connect = originalConnect;
  }
});
