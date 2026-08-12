import { createHmac, randomInt, randomUUID, timingSafeEqual } from "crypto";
import { Request } from "express";
import { PoolClient } from "pg";
import { env } from "../config/env";
import { pool, query } from "../db";
import { messagingProvider, MessageChannel } from "./messaging";

export type ChallengePurpose = "signup" | "phone_migration" | "phone_change" | "password_reset";

type ChallengeRow = {
  id: string;
  user_id: string | null;
  purpose: ChallengePurpose;
  pending_phone_e164: string;
  destination_hmac: string;
  ip_hmac: string;
  code_hash: string;
  expires_at: Date;
  attempt_count: number;
  max_attempts: number;
  last_sent_at: Date | null;
  last_channel: MessageChannel | null;
  consumed_at: Date | null;
  metadata: Record<string, unknown>;
};

export class ChallengeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function secret(): string {
  return env.AUTH_CHALLENGE_HMAC_SECRET || env.AUTH_TOKEN_SECRET || "quickserve-development-challenge-secret";
}

function hmac(scope: string, value: string): string {
  return createHmac("sha256", secret()).update(`${scope}:${value}`).digest("hex");
}

function codeHash(challengeId: string, code: string): string {
  return hmac("otp", `${challengeId}:${code}`);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function generateCode(): string {
  return randomInt(100_000, 1_000_000).toString();
}

async function lockAndEnforceLimits(
  client: PoolClient,
  destinationHmac: string,
  ipHmac: string
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [destinationHmac]);
  const result = await client.query<{ phone_hour: string; phone_day: string; ip_hour: string; ip_day: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE destination_hmac = $1 AND created_at > NOW() - INTERVAL '1 hour') AS phone_hour,
       COUNT(*) FILTER (WHERE destination_hmac = $1 AND created_at > NOW() - INTERVAL '1 day') AS phone_day,
       COUNT(*) FILTER (WHERE ip_hmac = $2 AND created_at > NOW() - INTERVAL '1 hour') AS ip_hour,
       COUNT(*) FILTER (WHERE ip_hmac = $2 AND created_at > NOW() - INTERVAL '1 day') AS ip_day
     FROM auth_message_attempts
     WHERE (destination_hmac = $1 OR ip_hmac = $2)
       AND created_at > NOW() - INTERVAL '1 day'`,
    [destinationHmac, ipHmac]
  );
  const counts = result.rows[0];
  if (
    Number(counts?.phone_hour) >= 5 ||
    Number(counts?.phone_day) >= 10 ||
    Number(counts?.ip_hour) >= 20 ||
    Number(counts?.ip_day) >= 50
  ) {
    throw new ChallengeError(429, "OTP_RATE_LIMITED", "Too many code requests. Please try again later.");
  }
}

async function deliver(
  challengeId: string,
  channel: MessageChannel,
  req: Request,
  options: { bypassChannelCooldown?: boolean; expectedUserId?: string } = {}
): Promise<{ channel: MessageChannel; messageId: string }> {
  const code = generateCode();
  const attemptId = `msg_${randomUUID()}`;
  const ipHmac = hmac("ip", requestIp(req));
  const client = await pool.connect();
  let challenge: ChallengeRow;
  try {
    await client.query("BEGIN");
    const result = await client.query<ChallengeRow>(
      "SELECT * FROM auth_challenges WHERE id = $1 FOR UPDATE",
      [challengeId]
    );
    challenge = result.rows[0];
    if (!challenge || challenge.consumed_at) {
      throw new ChallengeError(400, "CHALLENGE_INVALID", "This verification request is no longer valid.");
    }
    if (
      (challenge.purpose === "phone_change" || challenge.purpose === "phone_migration") &&
      (!options.expectedUserId || challenge.user_id !== options.expectedUserId)
    ) {
      throw new ChallengeError(403, "CHALLENGE_FORBIDDEN", "Authentication is required for this verification request.");
    }

    const elapsedSeconds = challenge.last_sent_at
      ? (Date.now() - new Date(challenge.last_sent_at).getTime()) / 1000
      : Number.POSITIVE_INFINITY;
    const requiredDelay = channel === "sms" && challenge.last_channel === "whatsapp" ? 30 : 60;
    if (!options.bypassChannelCooldown && elapsedSeconds < requiredDelay) {
      throw new ChallengeError(
        429,
        "OTP_COOLDOWN",
        `Please wait ${Math.ceil(requiredDelay - elapsedSeconds)} seconds before requesting another code.`
      );
    }

    await lockAndEnforceLimits(client, challenge.destination_hmac, ipHmac);
    await client.query(
      `INSERT INTO auth_message_attempts
         (id, challenge_id, destination_hmac, ip_hmac, purpose, channel, provider, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved')`,
      [attemptId, challenge.id, challenge.destination_hmac, ipHmac, challenge.purpose, channel, env.MESSAGING_PROVIDER]
    );
    await client.query(
      `UPDATE auth_challenges
       SET code_hash = $2, expires_at = NOW() + INTERVAL '5 minutes', attempt_count = 0,
           last_sent_at = NOW(), last_channel = $3, ip_hmac = $4,
           provider_message_id = NULL, provider_status = 'sending', updated_at = NOW()
       WHERE id = $1`,
      [challenge.id, codeHash(challenge.id, code), channel, ipHmac]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (!challenge.user_id) {
    await query(
      "UPDATE auth_message_attempts SET status = 'suppressed', updated_at = NOW() WHERE id = $1",
      [attemptId]
    );
    await query(
      "UPDATE auth_challenges SET provider_status = 'suppressed', updated_at = NOW() WHERE id = $1",
      [challenge.id]
    );
    return { channel, messageId: "" };
  }

  try {
    const sent = await messagingProvider().sendOtp({
      phoneE164: challenge.pending_phone_e164,
      code,
      channel,
      purpose: challenge.purpose,
    });
    await query(
      `UPDATE auth_message_attempts
       SET provider = $2, provider_message_id = $3, status = 'accepted', updated_at = NOW()
       WHERE id = $1`,
      [attemptId, sent.provider, sent.messageId]
    );
    await query(
      `UPDATE auth_challenges
       SET provider_message_id = $2, provider_status = $3, updated_at = NOW()
       WHERE id = $1`,
      [challenge.id, sent.messageId, sent.status]
    );
    return { channel, messageId: sent.messageId };
  } catch (error) {
    await query(
      "UPDATE auth_message_attempts SET status = 'failed', updated_at = NOW() WHERE id = $1",
      [attemptId]
    ).catch(() => undefined);
    await query(
      "UPDATE auth_challenges SET provider_status = 'failed', updated_at = NOW() WHERE id = $1",
      [challenge.id]
    ).catch(() => undefined);
    throw error;
  }
}

export async function createChallenge(input: {
  userId: string | null;
  purpose: ChallengePurpose;
  phoneE164: string;
  req: Request;
  metadata?: Record<string, unknown>;
  send?: boolean;
}): Promise<{ challengeId: string; channel: MessageChannel; expiresIn: number; smsAvailableIn: number }> {
  const id = `ach_${randomUUID()}`;
  const destinationHmac = hmac("phone", input.phoneE164);
  const ipHmac = hmac("ip", requestIp(input.req));
  await query(
    `INSERT INTO auth_challenges
       (id, user_id, purpose, pending_phone_e164, destination_hmac, ip_hmac,
        code_hash, expires_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '5 minutes', $8::jsonb)`,
    [id, input.userId, input.purpose, input.phoneE164, destinationHmac, ipHmac, codeHash(id, generateCode()), JSON.stringify(input.metadata || {})]
  );

  let deliveredChannel: MessageChannel = "whatsapp";
  if (input.send !== false) {
    try {
      await deliver(id, "whatsapp", input.req, { expectedUserId: input.userId || undefined });
    } catch (whatsappError) {
      try {
        await deliver(id, "sms", input.req, {
          bypassChannelCooldown: true,
          expectedUserId: input.userId || undefined,
        });
        deliveredChannel = "sms";
      } catch {
        throw whatsappError;
      }
    }
  }
  return {
    challengeId: id,
    channel: deliveredChannel,
    expiresIn: 300,
    smsAvailableIn: deliveredChannel === "whatsapp" ? 30 : 60,
  };
}

export async function resendChallenge(
  challengeId: string,
  channel: MessageChannel,
  req: Request,
  expectedUserId?: string
): Promise<{ challengeId: string; channel: MessageChannel; expiresIn: number; smsAvailableIn: number }> {
  await deliver(challengeId, channel, req, { expectedUserId });
  return { challengeId, channel, expiresIn: 300, smsAvailableIn: channel === "whatsapp" ? 30 : 60 };
}

export async function verifyChallenge(input: {
  challengeId: string;
  code: string;
  expectedPurpose?: ChallengePurpose | ChallengePurpose[];
  expectedUserId?: string;
}): Promise<{ userId: string; purpose: ChallengePurpose; phoneE164: string; resetToken?: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ChallengeRow>(
      `UPDATE auth_challenges
       SET attempt_count = attempt_count + 1, updated_at = NOW()
       WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW() AND attempt_count < max_attempts
       RETURNING *`,
      [input.challengeId]
    );
    const challenge = result.rows[0];
    const expected = Array.isArray(input.expectedPurpose) ? input.expectedPurpose : input.expectedPurpose ? [input.expectedPurpose] : [];
    if (
      !challenge ||
      !challenge.user_id ||
      (input.expectedUserId && challenge.user_id !== input.expectedUserId) ||
      (expected.length > 0 && !expected.includes(challenge.purpose)) ||
      !constantTimeEqual(challenge.code_hash, codeHash(challenge.id, input.code))
    ) {
      await client.query("COMMIT");
      throw new ChallengeError(400, "OTP_INVALID", "Invalid or expired verification code.");
    }

    let resetToken: string | undefined;
    if (challenge.purpose === "password_reset") {
      resetToken = `${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
      await client.query(
        `UPDATE auth_challenges
         SET consumed_at = NOW(), reset_token_hash = $2,
             reset_token_expires_at = NOW() + INTERVAL '10 minutes', updated_at = NOW()
         WHERE id = $1`,
        [challenge.id, hmac("reset", resetToken)]
      );
    } else {
      await client.query(
        `UPDATE users
         SET phone = $2, phone_e164 = $2, phone_verified_at = NOW(), verified = TRUE,
             whatsapp_security_consent_at = CASE
               WHEN COALESCE(($3::jsonb->>'whatsappSecurityConsent')::boolean, FALSE) THEN COALESCE(whatsapp_security_consent_at, NOW())
               ELSE whatsapp_security_consent_at
             END,
             whatsapp_transaction_consent_at = CASE
               WHEN COALESCE(($3::jsonb->>'updateWhatsappTransactionConsent')::boolean, FALSE)
                 THEN CASE
                   WHEN COALESCE(($3::jsonb->>'whatsappTransactionConsent')::boolean, FALSE) THEN NOW()
                   ELSE NULL
                 END
               WHEN COALESCE(($3::jsonb->>'whatsappTransactionConsent')::boolean, FALSE) THEN COALESCE(whatsapp_transaction_consent_at, NOW())
               ELSE whatsapp_transaction_consent_at
             END
         WHERE id = $1`,
        [challenge.user_id, challenge.pending_phone_e164, JSON.stringify(challenge.metadata || {})]
      );
      await client.query("UPDATE auth_challenges SET consumed_at = NOW(), updated_at = NOW() WHERE id = $1", [challenge.id]);
    }
    await client.query("COMMIT");
    return {
      userId: challenge.user_id,
      purpose: challenge.purpose,
      phoneE164: challenge.pending_phone_e164,
      resetToken,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") {
      throw new ChallengeError(409, "PHONE_IN_USE", "That phone number is already in use.");
    }
    throw error;
  } finally {
    client.release();
  }
}

export function resetTokenHash(token: string): string {
  return hmac("reset", token);
}

export function destinationFingerprint(phoneE164: string): string {
  return hmac("phone", phoneE164);
}

export async function cleanupExpiredAuthChallenges(): Promise<number> {
  const result = await query(
    `DELETE FROM auth_challenges
     WHERE created_at < NOW() - INTERVAL '7 days'
       AND (consumed_at IS NOT NULL OR expires_at < NOW())`
  );
  return result.rowCount;
}
