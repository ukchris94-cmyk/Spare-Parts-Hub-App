# AWS SMS authentication setup

QuickServe sends signup, password-reset, and phone-change OTPs through AWS End User Messaging SMS. The mobile app never receives AWS credentials.

## AWS account setup

1. Select `eu-west-1` in AWS End User Messaging SMS.
2. Add and verify test Nigerian destination numbers while the account is in the sandbox.
3. Create or request the `QuickServe` origination identity.
4. Create the `quickserve-auth` configuration set and enable delivery events/logging.
5. Create a protect configuration that permits Nigeria (`NG`) and blocks destinations QuickServe does not serve.
6. Send a sandbox test message.
7. Request SMS Production Access for `eu-west-1`. Describe the use case as transactional one-time passwords, provide the QuickServe URL, consent flow, and OTP template.
8. Set a conservative enforced monthly SMS spending limit and a billing alarm before enabling phone authentication.

## Runtime IAM

Attach this permission to the EC2 instance profile now, or the ECS task role after migration to Fargate. Do not create access keys for the application.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendQuickServeSecurityCodes",
      "Effect": "Allow",
      "Action": "sms-voice:SendTextMessage",
      "Resource": "*"
    }
  ]
}
```

Use AWS protect configurations, application-level `+234` validation, OTP rate limits, and spending limits as defense in depth. Revisit resource-level restrictions after AWS creates the final origination-identity resources in the account.

## Backend environment

Keep authentication disabled until sandbox delivery and production approval are complete:

```env
PHONE_AUTH_ENABLED=false
MESSAGING_PROVIDER=disabled
AWS_SMS_REGION=eu-west-1
AWS_SMS_ORIGINATION_IDENTITY=QuickServe
AWS_SMS_CONFIGURATION_SET=quickserve-auth
AWS_SMS_PROTECT_CONFIGURATION_ID=replace-with-protect-configuration-id
```

After approval and real-device testing:

```env
PHONE_AUTH_ENABLED=true
MESSAGING_PROVIDER=aws_sms
```

Restart the API with its updated environment after changing these values. Existing admin, staff, and legacy email login can remain enabled during rollout.

## Database deployment

Phone authentication still requires migration `011_phone_whatsapp_auth.sql`; its historical filename and internal column names are retained to avoid rewriting an applied migration.

```bash
cd /opt/spare-parts-hub/server
npm run migrate:prod
pm2 restart spare-parts-hub --update-env
```
