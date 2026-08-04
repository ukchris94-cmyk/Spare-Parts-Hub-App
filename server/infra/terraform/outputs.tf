output "api_url" {
  value = local.public_api_url
}

output "alb_dns_name" {
  value = aws_lb.api.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.backend.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "api_task_definition_arn" {
  value = aws_ecs_task_definition.api.arn
}

output "migration_task_definition_arn" {
  value = aws_ecs_task_definition.migration.arn
}

output "database_bootstrap_task_definition_arn" {
  value = try(aws_ecs_task_definition.database_bootstrap[0].arn, null)
}

output "private_app_subnet_ids" {
  value = values(aws_subnet.app)[*].id
}

output "ecs_security_group_id" {
  value = aws_security_group.ecs.id
}

output "nat_gateway_public_ip" {
  description = "Stable outbound IP to register with providers that support egress allowlisting."
  value       = aws_eip.nat.public_ip
}

output "database_endpoint" {
  value = aws_db_instance.postgres.endpoint
}

output "rds_master_secret_arn" {
  description = "Use only to bootstrap separate migration and runtime database roles."
  value       = try(aws_db_instance.postgres.master_user_secret[0].secret_arn, null)
}

output "runtime_secret_arn" {
  value = aws_secretsmanager_secret.runtime.arn
}

output "migration_secret_arn" {
  value = aws_secretsmanager_secret.migration.arn
}

output "database_bootstrap_secret_arn" {
  value = try(aws_secretsmanager_secret.database_bootstrap[0].arn, null)
}

output "media_bucket" {
  value = aws_s3_bucket.media.id
}

output "jobs_queue_url" {
  value = aws_sqs_queue.jobs.id
}

output "ses_verification_token" {
  description = "Add as _amazonses TXT when Route 53 is not managed by this stack."
  value       = aws_ses_domain_identity.main.verification_token
  sensitive   = true
}

output "ses_dkim_tokens" {
  description = "Add DKIM CNAMEs when Route 53 is not managed by this stack."
  value       = aws_ses_domain_dkim.main.dkim_tokens
}
