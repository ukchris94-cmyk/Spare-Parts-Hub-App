variable "aws_region" {
  description = "AWS region for QuickServe production resources."
  type        = string
  default     = "eu-west-1"
}

variable "project" {
  type    = string
  default = "quickserve"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "database_name" {
  description = "PostgreSQL database name created by RDS and used by bootstrap and migration tasks."
  type        = string
  default     = "quickserve"

  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_]{0,62}$", var.database_name))
    error_message = "database_name must be a valid unquoted PostgreSQL identifier."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "domain_name" {
  type    = string
  default = "backend.quickserve.com.ng"
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID for quickserve.com.ng; null when DNS is hosted elsewhere."
  type        = string
  default     = null
  nullable    = true
}

variable "acm_certificate_arn" {
  description = "Existing validated ACM certificate ARN; required when Route 53 is outside this stack."
  type        = string
  default     = null
  nullable    = true
}

variable "image_tag" {
  description = "Immutable ECR image tag, normally the Git commit SHA."
  type        = string
  default     = "bootstrap"
}

variable "deploy_services" {
  description = "Create ECS services only after the image and Secrets Manager values are ready."
  type        = bool
  default     = false
}

variable "enable_database_bootstrap" {
  description = "Create the one-time DB role bootstrap task. Disable and apply immediately after successful bootstrap."
  type        = bool
  default     = true
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "api_cpu" {
  type    = number
  default = 256
}

variable "api_memory" {
  type    = number
  default = 512
}

variable "worker_cpu" {
  type    = number
  default = 256
}

variable "worker_memory" {
  type    = number
  default = 512
}

variable "enable_api_autoscaling" {
  type    = bool
  default = true
}

variable "api_max_count" {
  type    = number
  default = 4
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_engine_version" {
  type    = string
  default = "16"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_max_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "db_multi_az" {
  description = "Keep true for payment production; false reduces cost but removes synchronous standby failover."
  type        = bool
  default     = true
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "db_backup_retention_days" {
  type    = number
  default = 14
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "monthly_budget_usd" {
  type    = number
  default = 250
}

variable "alert_email" {
  description = "Email for budgets and operational alerts."
  type        = string
}

variable "email_from" {
  description = "Verified SES sender used by the backend."
  type        = string
}

variable "email_reply_to" {
  type    = string
  default = ""
}

variable "ses_identity_domain" {
  description = "Domain to verify in SES for transactional email."
  type        = string
  default     = "quickserve.com.ng"
}

variable "cors_origins" {
  description = "Comma-separated browser origins; native mobile clients do not require CORS."
  type        = string
  default     = ""
}

variable "app_deep_link_scheme" {
  description = "Existing mobile deep-link scheme; changing it requires coordinated native builds."
  type        = string
  default     = "sparepartshubmobileclean"
}

variable "monnify_base_url" {
  type    = string
  default = "https://api.monnify.com"
}

variable "enable_monnify" {
  description = "Enable Monnify checkout and require its runtime secret keys. Keep false until credentials are issued."
  type        = bool
  default     = false
}

variable "monnify_webhook_ips" {
  description = "Comma-separated official Monnify webhook source IPs."
  type        = string
  default     = ""
}

variable "platform_fee_bps" {
  type    = number
  default = 700
}

variable "payment_tax_bps" {
  type    = number
  default = 0
}

variable "media_cors_origins" {
  description = "Optional web origins allowed to use presigned media URLs. Native mobile uploads do not need CORS."
  type        = list(string)
  default     = []
}

variable "enable_waf" {
  description = "Adds managed WAF rules and rate limiting. Recommended for payment production."
  type        = bool
  default     = true
}

variable "waf_rate_limit_per_5_minutes" {
  type    = number
  default = 2000
}

variable "enable_container_insights" {
  type    = bool
  default = false
}

variable "enable_deletion_protection" {
  type    = bool
  default = true
}
