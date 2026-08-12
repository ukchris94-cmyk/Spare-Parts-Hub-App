# QuickServe Phone and WhatsApp Authentication

This document covers the production rollout for public phone authentication, Termii OTP delivery, and WhatsApp payment receipts. Admin and staff authentication remains email and password based.

## External approvals

Complete these items before enabling phone authentication:

1. Obtain the current Termii Nigeria WhatsApp and SMS rate card and configure account spend alerts or caps.
2. Onboard QuickServe's WhatsApp Business number to Termii and confirm whether the number can remain in the existing mobile WhatsApp application.
3. Register and approve the `QuickServe` SMS sender ID and DND route.
4. Approve a WhatsApp authentication template with an `otp` variable.
5. Approve a WhatsApp utility receipt template with variables 1 through 8: order reference, payment reference, subtotal, platform fee, tax, total, payment method, and timestamp.
6. Obtain written Monnify approval to use merchant-controlled relay aliases in `customerEmail` for phone-only users.
7. Configure `payments@quickserve.com.ng` plus-address handling so relay messages are received and archived. Payment webhooks, not email, remain the source of truth.

## Database rollout

Back up the production database, deploy the server code with phone authentication disabled, and then run:

```bash
npm run migrate
npm run auth:phone-report > phone-migration-report.json
```

Review every invalid and duplicate legacy phone entry. The migration does not mark existing numbers verified and the report does not change user data.

## Secrets and environment

Generate independent secrets; do not reuse JWT, refresh-token, payment, or OTP secrets.

```env
ALLOW_LEGACY_PUBLIC_EMAIL_LOGIN=true
PHONE_AUTH_ENABLED=false
MESSAGING_PROVIDER=termii
TERMII_BASE_URL=https://<Termii-provided-regional-base-url>
TERMII_API_KEY=<secret>
TERMII_SECRET_KEY=<webhook-signing-secret>
TERMII_SENDER_ID=QuickServe
TERMII_WHATSAPP_DEVICE_ID=<approved-device-id>
TERMII_AUTH_TEMPLATE_ID=<approved-auth-template-id>
TERMII_PAYMENT_RECEIPT_TEMPLATE_ID=<approved-receipt-template-id>
AUTH_CHALLENGE_HMAC_SECRET=<at-least-32-random-characters>

MONNIFY_RELAY_EMAIL_APPROVED=true
PAYMENT_RELAY_EMAIL_DOMAIN=quickserve.com.ng
PAYMENT_RELAY_EMAIL_SECRET=<at-least-32-random-characters>
```

Store these values in AWS Secrets Manager or the existing ECS secret injection path. Do not put them in a mobile build, Terraform variable file committed to Git, image, log, or support ticket.

Set the Termii delivery-status webhook to:

```text
https://backend.quickserve.com.ng/api/messaging/webhook/termii
```

The endpoint requires `X-Termii-Signature`, computed by Termii as HMAC SHA-512 over the unmodified request body.

## Safe deployment order

1. Deploy migration 011 and the backend with `PHONE_AUTH_ENABLED=false`.
2. Run and review the phone migration report.
3. Configure and verify Termii credentials, templates, sender ID, DND route, fraud controls, webhook delivery, and spending limits.
4. Confirm Monnify relay aliases in writing and test that the QuickServe mailbox receives them.
5. Set `PHONE_AUTH_ENABLED=true` while retaining `ALLOW_LEGACY_PUBLIC_EMAIL_LOGIN=true`.
6. Release the mobile build containing phone signup, login, recovery, phone migration, and consent controls.
7. Monitor verification completion, WhatsApp delivery, SMS fallback, rate-limit events, duplicate numbers, and cost by carrier.
8. Ask legacy public users to add and verify a phone number after email login.
9. Set `ALLOW_LEGACY_PUBLIC_EMAIL_LOGIN=false` only after migration targets are met. Admin and staff email login remains enabled.

## Security behavior

- Only Nigerian mobile numbers are accepted and stored in `+234` E.164 format.
- OTPs are six digits, generated cryptographically, HMAC-protected at rest, expire after five minutes, and allow five attempts.
- A resend has a 60-second cooldown. User-triggered SMS fallback becomes available 30 seconds after WhatsApp.
- PostgreSQL advisory locks and HMAC destination/IP fingerprints enforce cross-instance send limits without storing raw IP addresses.
- Password reset tokens are short-lived and single-use. A completed reset or phone change revokes all refresh sessions.
- Public phone verification can activate signup challenges only. Phone migration and change verification require an authenticated session.
- Payment receipt messages are queued only after server-side Monnify verification creates the paid order. They are never generated from a mobile callback.
- Receipt failure preserves the in-app receipt and never sends payment details by ordinary SMS.

## Production validation

Before launch, test real WhatsApp and fallback SMS delivery on MTN, Airtel, Glo, and 9mobile. Verify wrong-code limits, cooldowns, concurrent sends, unknown-account recovery, session revocation, phone changes, webhook replay, invalid webhook signatures, Monnify underpayment rejection, and one receipt for one paid transaction.

Keep `PHONE_AUTH_ENABLED=false` if any provider approval, template, relay-email approval, or carrier validation is incomplete.
