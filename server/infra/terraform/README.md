# QuickServe AWS infrastructure

This stack deploys the QuickServe backend to `eu-west-1` with payment-oriented
security defaults and controlled baseline cost.

## Architecture

- One VPC tagged `quickserve`, spanning two availability zones.
- Public subnets contain only the Application Load Balancer and one NAT gateway.
- Private application subnets contain ARM64 ECS Fargate API and worker tasks.
- Isolated database subnets contain encrypted PostgreSQL RDS.
- ALB terminates TLS, redirects HTTP, drops invalid headers, and is protected by WAF.
- S3 media is private, versioned, KMS-encrypted, and accessed with presigned URLs.
- SQS and a DLQ run asynchronous notifications and outbox jobs.
- Secrets Manager holds runtime and migration secrets; values never enter Terraform state.
- RDS manages and rotates its master password. The app uses separate runtime and migration users.
- CloudWatch alarms, SNS notifications, and an AWS Budget provide basic operations coverage.

The single NAT gateway is intentional for early-stage cost control and gives QuickServe a
stable egress IP. It is an availability tradeoff: add one NAT per AZ later if uninterrupted
outbound provider access during an AZ failure becomes necessary.

## Prerequisites

- Terraform 1.10 or newer.
- AWS CLI v2 authenticated to the production account without long-lived keys in this repo.
- Docker with BuildKit/buildx.
- DNS hosted in Route 53, or an existing validated ACM certificate in `eu-west-1`.
- Confirmed production Monnify webhook source IPs.

## 1. Bootstrap remote Terraform state

The bootstrap stack uses local state only to create a private, encrypted, versioned S3 state
bucket. S3 native lock files are used; no DynamoDB lock table is required.

```bash
cd infra/terraform/bootstrap
terraform init
terraform plan -out bootstrap.tfplan
terraform apply bootstrap.tfplan
terraform output -raw backend_configuration
```

Create `../backend.hcl` from that output. Do not commit it.

## 2. Configure production variables

```bash
cd ..
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`. Keep `deploy_services = false` for the first apply. If DNS is in
Route 53, set `route53_zone_id`. Otherwise request and validate an ACM certificate manually,
set `acm_certificate_arn`, and later point the DNS record to the `alb_dns_name` output.

Never put Monnify keys, JWT secrets, database passwords, Google keys, Expo tokens, or other
secret values in `.tfvars`.

## 3. Create infrastructure

```bash
terraform init -backend-config=backend.hcl
terraform fmt -check -recursive
terraform validate
terraform plan -out production.tfplan
terraform apply production.tfplan
```

Review every plan. Do not use automatic approval for production changes.

## 4. Build and publish the ARM64 image

Use an immutable Git SHA tag. ARM64 Linux is supported by Fargate and the backend image has
already been structured for it.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT_ID.dkr.ecr.eu-west-1.amazonaws.com"
IMAGE_TAG=$(git rev-parse HEAD)

aws ecr get-login-password --region eu-west-1 \
  | docker login --username AWS --password-stdin "$REGISTRY"

docker buildx build \
  --platform linux/arm64 \
  --provenance=true \
  --sbom=true \
  --tag "$(terraform output -raw ecr_repository_url):$IMAGE_TAG" \
  --push ../..
```

Set `image_tag = "<the Git SHA>"` in `terraform.tfvars` and apply again. ECR tags are
immutable, so never reuse a tag.

## 5. Bootstrap least-privilege database users

Download the public RDS CA bundle and base64-encode it without line wrapping:

```bash
curl -fsS https://truststore.pki.rds.amazonaws.com/eu-west-1/eu-west-1-bundle.pem \
  | base64 | tr -d '\n'
```

Generate two independent passwords of at least 32 characters. Populate the
`database_bootstrap_secret_arn` secret in the AWS console with this JSON shape:

```json
{
  "RUNTIME_DB_PASSWORD": "REPLACE",
  "MIGRATION_DB_PASSWORD": "REPLACE",
  "DATABASE_CA_BASE64": "REPLACE_WITH_PUBLIC_CA_BASE64"
}
```

Run the one-time database bootstrap task in the private app subnets:

```bash
aws ecs run-task \
  --region eu-west-1 \
  --cluster "$(terraform output -raw ecs_cluster_name)" \
  --task-definition "$(terraform output -raw database_bootstrap_task_definition_arn)" \
  --launch-type FARGATE \
  --platform-version 1.4.0 \
  --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -json private_app_subnet_ids | jq -r 'join(",")')],securityGroups=[$(terraform output -raw ecs_security_group_id)],assignPublicIp=DISABLED}"
```

Wait for exit code `0` in ECS and inspect the migration log group. The task safely creates or
rotates `quickserve_runtime` and `quickserve_migrator`; it does not expose PostgreSQL publicly.

Immediately set `enable_database_bootstrap = false`, review a new plan, and apply it. This
removes the bootstrap task definition and its access to the RDS master secret, and schedules
the duplicate bootstrap secret for deletion. Runtime and migration credentials remain in
their separate secrets.

## 6. Populate application secrets

Populate the runtime secret with every key below. Monnify keys are not required while
`enable_monnify = false`.

```json
{
  "DATABASE_URL": "postgresql://quickserve_runtime:URL_ENCODED_PASSWORD@RDS_HOST:5432/quickserve",
  "DATABASE_CA_BASE64": "REPLACE_WITH_PUBLIC_CA_BASE64",
  "AUTH_TOKEN_SECRET": "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS",
  "REFRESH_TOKEN_PEPPER": "REPLACE_WITH_DIFFERENT_RANDOM_VALUE",
  "GOOGLE_MAPS_SERVER_API_KEY": "REPLACE",
  "EXPO_ACCESS_TOKEN": ""
}
```

After Monnify issues credentials, add `MONNIFY_API_KEY`, `MONNIFY_SECRET_KEY`,
`MONNIFY_CONTRACT_CODE`, and `MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT` to the runtime secret,
set the official `monnify_webhook_ips`, and change `enable_monnify = true`.

Populate the migration secret:

```json
{
  "DATABASE_MIGRATION_URL": "postgresql://quickserve_migrator:URL_ENCODED_PASSWORD@RDS_HOST:5432/quickserve",
  "DATABASE_CA_BASE64": "REPLACE_WITH_PUBLIC_CA_BASE64"
}
```

Use the Secrets Manager console or `aws secretsmanager put-secret-value` with a local JSON
file whose mode is `0600`. Do not place values directly on a command line or commit the file.

## 7. Run migrations

```bash
aws ecs run-task \
  --region eu-west-1 \
  --cluster "$(terraform output -raw ecs_cluster_name)" \
  --task-definition "$(terraform output -raw migration_task_definition_arn)" \
  --launch-type FARGATE \
  --platform-version 1.4.0 \
  --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -json private_app_subnet_ids | jq -r 'join(",")')],securityGroups=[$(terraform output -raw ecs_security_group_id)],assignPublicIp=DISABLED}"
```

Confirm exit code `0`. The migration runner uses an advisory lock and checksum history, and
grants runtime access only to application tables and sequences.

## 8. Start services

Set `deploy_services = true`, run a fresh plan, and apply it. Then verify:

```bash
curl --fail --show-error https://backend.quickserve.com.ng/healthz
curl --fail --show-error https://backend.quickserve.com.ng/readyz
```

Confirm the SNS subscription email, SES domain/DKIM verification, and request SES production
access if the account is still in the sandbox. Configure Monnify with:

- Webhook: `https://backend.quickserve.com.ng/api/payments/webhook/monnify`
- Redirect: `https://backend.quickserve.com.ng/api/payments/return/monnify`

## Cost controls and deliberate choices

- ARM64 Fargate tasks use the smallest practical production task size.
- Two API tasks remain the default because payment callbacks must survive one task failure.
- One worker task is enough initially; SQS retains work across restarts.
- One NAT gateway saves the second hourly NAT charge and provides a stable provider egress IP.
- No paid interface VPC endpoints are created at low traffic; reassess when NAT data cost grows.
- Container Insights is off by default; standard logs and alarms remain enabled.
- RDS uses Graviton `db.t4g.small`, gp3 autoscaling storage, and Multi-AZ by default.
- WAF is enabled because checkout and webhook endpoints are internet-facing.
- S3 lifecycle rules remove stale noncurrent media versions after 30 days.

Do not disable Multi-AZ, WAF, deletion protection, backups, TLS, or secret separation in
production merely to reduce the bill. Use a separate non-production environment for cheaper
single-instance testing.

## Operational follow-up

- Keep `enable_database_bootstrap=false` after credentials are established. Re-enable it only
  during an approved credential recovery or rotation procedure.
- Rotate auth, refresh, database, Monnify, Google, and Expo secrets on a defined schedule.
- Enable account-level CloudTrail, GuardDuty, Security Hub, MFA, and root-account protections.
- Add CI/CD with OIDC and scoped deployment roles; do not create AWS access keys for CI.
- Add a second NAT gateway only when the availability requirement justifies its fixed cost.
- Test RDS restore, ECS rollback, Monnify webhook replay, queue redrive, and secret rotation.
