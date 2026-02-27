variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region"
}

variable "instance_type" {
  type        = string
  default     = "t2.micro" # free-tier eligible in many accounts; use t2.micro if needed
}

variable "ssh_key_name" {
  type        = string
  description = "Name for AWS key pair"
}

variable "ssh_public_key" {
  type        = string
  description = "Public key material for SSH"
}
