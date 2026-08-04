# QuickServe manual AWS production deployment

This document is the manual alternative to `infra/terraform`. Do not manually
create or change resources that are already managed by Terraform. Choose one
ownership model per environment to prevent configuration drift.

Target region: `eu-west-1`.

## Architecture

- A two-AZ VPC with public ALB subnets, private ECS subnets, and isolated RDS subnets
- One NAT gateway with an Elastic IP for stable outbound provider traffic
- An internet-facing HTTPS ALB with ACM and optional AWS WAF
- ARM64 ECS Fargate services for the API and background worker
- A private encrypted PostgreSQL RDS instance
- ECR for immutable backend images
- KMS-encrypted private S3 media storage
- SQS plus a dead-letter queue
- Secrets Manager for application and migration credentials
- CloudWatch logs, alarms, SNS notifications, and AWS Budgets
- Gmail SMTP for low-volume transactional email

## Manual order of operations

1. Create the VPC across two availability zones.
2. Create two public, two private application, and two isolated database subnets.
3. Attach an internet gateway to the public route table.
4. Create one NAT gateway and route private application traffic through it.
5. Leave database subnet route tables without internet routes.
6. Create ALB, ECS, and database security groups. Permit ALB to ECS on port 4000
   and ECS to RDS on port 5432 only.
7. Create an encrypted private S3 media bucket with public access blocked,
   versioning enabled, and a lifecycle policy for incomplete uploads and old versions.
8. Create separate KMS keys for media and payout-sensitive data with rotation enabled.
9. Create ECR with immutable tags and image scanning.
10. Build and push the Docker image for `linux/arm64` using a Git commit SHA tag.
11. Create SQS job and dead-letter queues with server-side encryption and redrive rules.
12. Create PostgreSQL RDS in the isolated subnets with SSL enforcement, backups,
    deletion protection, and an RDS-managed master password.
13. From temporary private access, create separate `quickserve_migrator` and
    `quickserve_runtime` database roles. Never use the RDS master user in the API.
14. Create runtime and migration Secrets Manager secrets. Store no secrets in source
    control, Docker images, task-definition plaintext, or shell history.
15. Create least-privilege ECS execution, runtime, and migration IAM roles.
16. Create CloudWatch log groups and ARM64 Fargate task definitions for API, worker,
    and one-off migrations.
17. Run the migration task and confirm exit code `0` before starting services.
18. Create the target group using `/readyz`, ALB listeners, ACM certificate, DNS,
    and WAF rules.
19. Start two API tasks and one worker in private subnets without public IP addresses.
20. Configure CloudWatch alarms, SNS email confirmation, and monthly budget alerts.
21. Create a dedicated Gmail account, enable 2-Step Verification, generate an app password,
    and store `SMTP_USER` and `SMTP_PASS` in the runtime secret.
22. Configure Monnify webhook and redirect URLs.

## Required application URLs

- Public API: `https://backend.quickserve.com.ng/api`
- Health: `https://backend.quickserve.com.ng/healthz`
- Readiness: `https://backend.quickserve.com.ng/readyz`
- Monnify webhook: `https://backend.quickserve.com.ng/api/payments/webhook/monnify`
- Monnify redirect: `https://backend.quickserve.com.ng/api/payments/return/monnify`

## Production checks

- RDS is not publicly accessible.
- ECS tasks have no public IP addresses.
- TLS 1.2 or newer is enforced at the ALB.
- WAF is enabled and tested against legitimate Monnify callbacks.
- Secrets exist only in Secrets Manager and an approved password manager.
- Runtime database permissions exclude schema and role administration.
- Payment webhooks remain signature-verified and idempotent in application code.
- S3 public access is blocked and object encryption uses the media KMS key.
- CloudWatch alarms and budget notifications are confirmed.
- Database restore and ECS rollback procedures have been tested.

For the Terraform-managed production environment, follow
`infra/terraform/README.md` instead of this manual procedure.
