import { createHmac, timingSafeEqual } from "crypto";
import { Request, Response, NextFunction } from "express";
import { query } from "../db";

type TokenPayload = {
  sub: string;
  iat: number;
};

export type AuthenticatedUser = {
  id: string;
  role: string;
};

const tokenSecret =
  process.env.AUTH_TOKEN_SECRET ||
  process.env.DATABASE_URL ||
  "spareparts-hub-development-token-secret";

function base64UrlEncode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(value: string): string {
  return createHmac("sha256", tokenSecret).update(value).digest("base64url");
}

export function createAuthToken(userId: string): string {
  const encodedPayload = base64UrlEncode(
    JSON.stringify({ sub: userId, iat: Math.floor(Date.now() / 1000) } satisfies TokenPayload)
  );
  return `v1.${encodedPayload}.${sign(encodedPayload)}`;
}

function verifyAuthToken(token: string): TokenPayload | null {
  const [version, encodedPayload, signature] = token.split(".");
  if (version !== "v1" || !encodedPayload || !signature) return null;

  const expected = sign(encodedPayload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload || typeof payload.sub !== "string" || typeof payload.iat !== "number") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function requireRoles(...allowedRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ ok: false, message: "Authentication required" });
    }

    const payload = verifyAuthToken(match[1]);
    if (!payload) {
      return res.status(401).json({ ok: false, message: "Invalid authentication token" });
    }

    const { rows } = await query<{ id: string; role: string }>(
      "SELECT id, role FROM users WHERE id = $1 LIMIT 1",
      [payload.sub]
    );
    const user = rows[0];
    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(403).json({ ok: false, message: "Not authorized" });
    }

    req.user = { id: user.id, role: user.role };
    return next();
  };
}
