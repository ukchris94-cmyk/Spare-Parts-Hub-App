locals {
  name = "${var.project}-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)

  common_tags = {
    Application = "quickserve"
    Environment = var.environment
    ManagedBy   = "terraform"
    Project     = var.project
    QuickServe  = "true"
  }

  public_api_url       = "https://${var.domain_name}/api"
  monnify_redirect_url = "https://${var.domain_name}/api/payments/return/monnify"
  tls_certificate_arn  = var.acm_certificate_arn != null ? var.acm_certificate_arn : try(aws_acm_certificate_validation.api[0].certificate_arn, null)

  runtime_secret_keys = concat([
    "DATABASE_URL",
    "DATABASE_CA_BASE64",
    "AUTH_TOKEN_SECRET",
    "REFRESH_TOKEN_PEPPER",
    "GOOGLE_MAPS_SERVER_API_KEY",
    "EXPO_ACCESS_TOKEN",
    ], var.enable_monnify ? [
    "MONNIFY_API_KEY",
    "MONNIFY_SECRET_KEY",
    "MONNIFY_CONTRACT_CODE",
    "MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT",
  ] : [])
}

check "tls_configuration" {
  assert {
    condition     = var.route53_zone_id != null || var.acm_certificate_arn != null
    error_message = "Set route53_zone_id or provide an existing validated acm_certificate_arn."
  }
}
