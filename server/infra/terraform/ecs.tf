resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "migration" {
  name              = "/ecs/${local.name}/migration"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }
}

locals {
  app_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "4000" },
    { name = "LOG_LEVEL", value = "info" },
    { name = "PUBLIC_API_URL", value = local.public_api_url },
    { name = "ENFORCE_HTTPS", value = "true" },
    { name = "TRUST_PROXY_HOPS", value = "1" },
    { name = "DATABASE_SSL", value = "true" },
    { name = "DATABASE_POOL_MAX", value = "5" },
    { name = "ALLOW_LEGACY_AUTH_TOKENS", value = "false" },
    { name = "ACCESS_TOKEN_TTL_SECONDS", value = "900" },
    { name = "REFRESH_TOKEN_TTL_DAYS", value = "30" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "EMAIL_FROM", value = var.email_from },
    { name = "EMAIL_REPLY_TO", value = var.email_reply_to },
    { name = "EMAIL_DELIVERY_MODE", value = "ses" },
    { name = "CORS_ORIGINS", value = var.cors_origins },
    { name = "APP_DEEP_LINK_SCHEME", value = var.app_deep_link_scheme },
    { name = "PAYMENTS_ENABLED", value = tostring(var.enable_monnify) },
    { name = "PAYMENT_PROVIDER", value = "monnify" },
    { name = "PAYMENT_CURRENCY", value = "NGN" },
    { name = "PLATFORM_FEE_BPS", value = tostring(var.platform_fee_bps) },
    { name = "PAYMENT_TAX_BPS", value = tostring(var.payment_tax_bps) },
    { name = "MONNIFY_BASE_URL", value = var.monnify_base_url },
    { name = "MONNIFY_REDIRECT_URL", value = local.monnify_redirect_url },
    { name = "MONNIFY_WEBHOOK_IPS", value = var.monnify_webhook_ips },
    { name = "MONNIFY_DISBURSEMENTS_ENABLED", value = "false" },
    { name = "MEDIA_BUCKET", value = aws_s3_bucket.media.id },
    { name = "MEDIA_KMS_KEY_ID", value = aws_kms_key.media.arn },
    { name = "PAYOUT_KMS_KEY_ID", value = aws_kms_key.payout.arn },
    { name = "JOBS_QUEUE_URL", value = aws_sqs_queue.jobs.id },
  ]

  app_secrets = [for key in local.runtime_secret_keys : {
    name      = key
    valueFrom = "${aws_secretsmanager_secret.runtime.arn}:${key}::"
  }]

  api_container = {
    name                   = "api"
    image                  = "${aws_ecr_repository.backend.repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    stopTimeout            = 30
    portMappings = [{
      name          = "http"
      containerPort = 4000
      hostPort      = 4000
      protocol      = "tcp"
    }]
    environment     = local.app_environment
    secrets         = local.app_secrets
    linuxParameters = { initProcessEnabled = true }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "api"
      }
    }
  }

  worker_container = {
    name                   = "worker"
    image                  = "${aws_ecr_repository.backend.repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    stopTimeout            = 30
    command                = ["node", "dist/worker.js"]
    environment            = local.app_environment
    secrets                = local.app_secrets
    linuxParameters        = { initProcessEnabled = true }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "worker"
      }
    }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  container_definitions    = jsonencode([local.api_container])
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  container_definitions    = jsonencode([local.worker_container])
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
}

resource "aws_ecs_task_definition" "migration" {
  family                   = "${local.name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.migration.arn
  container_definitions = jsonencode([{
    name                   = "migration"
    image                  = "${aws_ecr_repository.backend.repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    command                = ["node", "dist/db/migrate.js"]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "DATABASE_SSL", value = "true" },
      { name = "DATABASE_RUNTIME_ROLE", value = "quickserve_runtime" },
    ]
    secrets = [
      { name = "DATABASE_MIGRATION_URL", valueFrom = "${aws_secretsmanager_secret.migration.arn}:DATABASE_MIGRATION_URL::" },
      { name = "DATABASE_CA_BASE64", valueFrom = "${aws_secretsmanager_secret.migration.arn}:DATABASE_CA_BASE64::" },
    ]
    linuxParameters = { initProcessEnabled = true }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migration.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "migration"
      }
    }
  }])
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
}

resource "aws_ecs_task_definition" "database_bootstrap" {
  count                    = var.enable_database_bootstrap ? 1 : 0
  family                   = "${local.name}-database-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.migration.arn
  container_definitions = jsonencode([{
    name                   = "database-bootstrap"
    image                  = "${aws_ecr_repository.backend.repository_url}:${var.image_tag}"
    essential              = true
    readonlyRootFilesystem = true
    command                = ["node", "dist/scripts/bootstrap-database-roles.js"]
    environment = [
      { name = "MASTER_DB_NAME", value = var.database_name },
      { name = "MASTER_DB_HOST", value = aws_db_instance.postgres.address },
      { name = "MASTER_DB_PORT", value = tostring(aws_db_instance.postgres.port) },
      { name = "MASTER_DB_USERNAME", value = aws_db_instance.postgres.username },
    ]
    secrets = [
      { name = "MASTER_DB_PASSWORD", valueFrom = "${aws_db_instance.postgres.master_user_secret[0].secret_arn}:password::" },
      { name = "RUNTIME_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database_bootstrap[0].arn}:RUNTIME_DB_PASSWORD::" },
      { name = "MIGRATION_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.database_bootstrap[0].arn}:MIGRATION_DB_PASSWORD::" },
      { name = "DATABASE_CA_BASE64", valueFrom = "${aws_secretsmanager_secret.database_bootstrap[0].arn}:DATABASE_CA_BASE64::" },
    ]
    linuxParameters = { initProcessEnabled = true }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.migration.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "database-bootstrap"
      }
    }
  }])
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
}

resource "aws_ecs_service" "api" {
  count                              = var.deploy_services ? 1 : 0
  name                               = "api"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  enable_execute_command             = false

  network_configuration {
    subnets          = values(aws_subnet.app)[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  count                              = var.deploy_services ? 1 : 0
  name                               = "worker"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.worker_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  enable_execute_command             = false

  network_configuration {
    subnets          = values(aws_subnet.app)[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

resource "aws_appautoscaling_target" "api" {
  count              = var.deploy_services && var.enable_api_autoscaling ? 1 : 0
  max_capacity       = var.api_max_count
  min_capacity       = var.api_desired_count
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  count              = var.deploy_services && var.enable_api_autoscaling ? 1 : 0
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api[0].resource_id
  scalable_dimension = aws_appautoscaling_target.api[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.api[0].service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 180
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
