import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { NextFunction, Request, Response } from "express";
import { PoolClient } from "pg";
import { env } from "../config/env";
import { pool, query } from "../db";

type AccessTokenPayload = {
  sub: string;
  sid: string;
  ver: number;
  iat: number;
  exp: number;
};

type LegacyTokenPayload = {
  sub: string;
  iat: number;
};

export type AuthenticatedUser = {
  id: string;
  role: string;
  sessionId?: string;
};

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

const accessSecret =
  env.AUTH_TOKEN_SECRET || "quickserve-development-access-token-secret";
const refreshPepper =
  env.REFRESH_TOKEN_PEPPER || "quickserve-development-refresh-token-pepper";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(value: string): string {
  return createHmac("sha256", accessSecret).update(value).digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createAccessToken(userId: string, sessionId: string, tokenVersion: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessTokenPayload = {
    sub: userId,
    sid: sessionId,
    ver: tokenVersion,
    iat: now,
    exp: now + env.ACCESS_TOKEN_TTL_SECONDS,
  };
  const encoded = encode(payload);
  return `v2.${encoded}.${sign(encoded)}`;
}

function verifyAccessToken(token: string): AccessTokenPayload | null {
  const [version, encodedPayload, signature] = token.split(".");
  if (version !== "v2" || !encodedPayload || !signature) return null;
  if (!constantTimeEqual(signature, sign(encodedPayload))) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as Partial<AccessTokenPayload>;
    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.ver !== "number" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp <= now ||
      payload.iat > now + 60
    ) {
      return null;
    }
    return payload as AccessTokenPayload;
  } catch {
    return null;
  }
}

function verifyLegacyToken(token: string): LegacyTokenPayload | null {
  if (!env.allowLegacyAuthTokens) return null;
  const [version, encodedPayload, signature] = token.split(".");
  if (version !== "v1" || !encodedPayload || !signature) return null;
  if (!constantTimeEqual(signature, sign(encodedPayload))) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as Partial<LegacyTokenPayload>;
    if (typeof payload.sub !== "string" || typeof payload.iat !== "number") return null;
    return payload as LegacyTokenPayload;
  } catch {
    return null;
  }
}

function refreshHash(token: string): string {
  return createHmac("sha256", refreshPepper).update(token).digest("hex");
}

function clientMetadata(req: Request): { userAgent: string | null; ipHash: string | null } {
  const userAgent = req.header("user-agent")?.slice(0, 512) || null;
  const address = req.ip || req.socket.remoteAddress;
  return {
    userAgent,
    ipHash: address
      ? createHash("sha256").update(`${refreshPepper}:${address}`).digest("hex")
      : null,
  };
}

async function insertSession(
  client: PoolClient,
  params: {
    userId: string;
    tokenVersion: number;
    familyId?: string;
    request: Request;
  }
): Promise<SessionTokens & { sessionId: string; familyId: string }> {
  const sessionId = randomUUID();
  const familyId = params.familyId || randomUUID();
  const secret = randomBytes(32).toString("base64url");
  const refreshToken = `r1.${sessionId}.${secret}`;
  const expiresAt = new Date(
    Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  );
  const metadata = clientMetadata(params.request);

  await client.query(
    `INSERT INTO auth_sessions
       (id, user_id, family_id, refresh_token_hash, expires_at, user_agent, ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      sessionId,
      params.userId,
      familyId,
      refreshHash(refreshToken),
      expiresAt,
      metadata.userAgent,
      metadata.ipHash,
    ]
  );

  return {
    sessionId,
    familyId,
    accessToken: createAccessToken(params.userId, sessionId, params.tokenVersion),
    refreshToken,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function createSessionTokens(userId: string, req: Request): Promise<SessionTokens> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ token_version: number }>(
      "SELECT token_version FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [userId]
    );
    const user = result.rows[0];
    if (!user) throw new Error("User is not available");
    const tokens = await insertSession(client, {
      userId,
      tokenVersion: user.token_version,
      request: req,
    });
    await client.query("COMMIT");
    return tokens;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function rotateRefreshToken(token: string, req: Request): Promise<SessionTokens | null> {
  const [version, sessionId] = token.split(".");
  if (version !== "r1" || !sessionId || token.length > 512) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      id: string;
      user_id: string;
      family_id: string;
      refresh_token_hash: string;
      expires_at: Date;
      revoked_at: Date | null;
      token_version: number;
      deleted_at: Date | null;
    }>(
      `SELECT s.id, s.user_id, s.family_id, s.refresh_token_hash, s.expires_at,
              s.revoked_at, u.token_version, u.deleted_at
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1
       FOR UPDATE OF s`,
      [sessionId]
    );
    const session = result.rows[0];
    if (!session) {
      await client.query("ROLLBACK");
      return null;
    }

    const suppliedHash = refreshHash(token);
    const tokenMatches = constantTimeEqual(suppliedHash, session.refresh_token_hash);
    const expired = new Date(session.expires_at).getTime() <= Date.now();
    if (!tokenMatches || session.revoked_at || expired || session.deleted_at) {
      await client.query(
        "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE family_id = $1",
        [session.family_id]
      );
      await client.query("COMMIT");
      return null;
    }

    const next = await insertSession(client, {
      userId: session.user_id,
      tokenVersion: session.token_version,
      familyId: session.family_id,
      request: req,
    });
    await client.query(
      `UPDATE auth_sessions
       SET revoked_at = NOW(), replaced_by = $2, last_used_at = NOW()
       WHERE id = $1`,
      [session.id, next.sessionId]
    );
    await client.query("COMMIT");
    return next;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  await query("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1", [
    sessionId,
  ]);
}

export async function revokeRefreshToken(token: string | undefined): Promise<void> {
  if (!token || token.length > 512) return;
  const [version, sessionId] = token.split(".");
  if (version !== "r1" || !sessionId) return;
  await query(
    `UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE id = $1 AND refresh_token_hash = $2`,
    [sessionId, refreshHash(token)]
  );
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await query(
    "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1",
    [userId]
  );
}

export async function authenticateRequest(req: Request): Promise<AuthenticatedUser | null> {
  const header = req.header("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const accessPayload = verifyAccessToken(match[1]);
  if (accessPayload) {
    const { rows } = await query<{ id: string; role: string }>(
      `SELECT u.id, u.role
       FROM users u
       JOIN auth_sessions s ON s.id = $2 AND s.user_id = u.id
       WHERE u.id = $1
         AND u.deleted_at IS NULL
         AND u.token_version = $3
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
       LIMIT 1`,
      [accessPayload.sub, accessPayload.sid, accessPayload.ver]
    );
    const user = rows[0];
    return user ? { ...user, sessionId: accessPayload.sid } : null;
  }

  const legacyPayload = verifyLegacyToken(match[1]);
  if (!legacyPayload) return null;
  const { rows } = await query<{ id: string; role: string }>(
    "SELECT id, role FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1",
    [legacyPayload.sub]
  );
  return rows[0] || null;
}

export function requireRoles(...allowedRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = await authenticateRequest(req);
    if (!user) {
      res.status(401).json({ ok: false, message: "Authentication required" });
      return;
    }
    if (!allowedRoles.includes(user.role)) {
      res.status(403).json({ ok: false, message: "Not authorized" });
      return;
    }
    req.user = user;
    next();
  };
}

export async function requireAuthenticated(req: Request, res: Response, next: NextFunction) {
  const user = await authenticateRequest(req);
  if (!user) {
    res.status(401).json({ ok: false, message: "Invalid or expired authentication token" });
    return;
  }
  req.user = user;
  next();
}
