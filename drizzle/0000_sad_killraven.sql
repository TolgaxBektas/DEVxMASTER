CREATE TABLE `ai_usage_ledger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`provider` varchar(64) NOT NULL,
	`model` varchar(128) NOT NULL,
	`operation` varchar(32) NOT NULL,
	`input_tokens` int NOT NULL DEFAULT 0,
	`output_tokens` int NOT NULL DEFAULT 0,
	`cost_micros` int NOT NULL DEFAULT 0,
	`object_type` varchar(128),
	`object_id` varchar(128),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ai_usage_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`seq` int NOT NULL,
	`tenant_id` int,
	`action` varchar(128) NOT NULL,
	`entity_type` varchar(128) NOT NULL,
	`entity_id` varchar(128),
	`details_json` text,
	`actor_id` int,
	`actor_name` varchar(255),
	`prev_hash` varchar(64) NOT NULL,
	`hash` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`),
	CONSTRAINT `audit_log_seq_uq` UNIQUE(`seq`)
);
--> statement-breakpoint
CREATE TABLE `automation_policies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`operation` varchar(128) NOT NULL,
	`mode` enum('automatic','suggestion','human_required') NOT NULL DEFAULT 'human_required',
	`config` json,
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `automation_policies_id` PRIMARY KEY(`id`),
	CONSTRAINT `automation_policies_tenant_operation_uq` UNIQUE(`tenant_id`,`operation`)
);
--> statement-breakpoint
CREATE TABLE `event_outbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`event_id` varchar(36) NOT NULL,
	`tenant_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`aggregate_type` varchar(128) NOT NULL,
	`aggregate_id` varchar(128) NOT NULL,
	`payload` json NOT NULL,
	`idempotency_key` varchar(255) NOT NULL,
	`published_at` datetime,
	`attempts` int NOT NULL DEFAULT 0,
	`delivery_attempts` int NOT NULL DEFAULT 0,
	`next_attempt_at` datetime,
	`dead_letter` boolean NOT NULL DEFAULT false,
	`successful_handlers` json NOT NULL,
	`last_error` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `event_outbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `event_outbox_event_uq` UNIQUE(`event_id`),
	CONSTRAINT `event_outbox_idempotency_uq` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `feature_flags` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`key` varchar(128) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`config` json,
	CONSTRAINT `feature_flags_id` PRIMARY KEY(`id`),
	CONSTRAINT `feature_flags_tenant_key_uq` UNIQUE(`tenant_id`,`key`)
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`job_id` varchar(36) NOT NULL,
	`status` varchar(32) NOT NULL,
	`started_at` datetime NOT NULL,
	`completed_at` datetime,
	`error_message` text,
	`metadata` json,
	CONSTRAINT `job_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` varchar(36) NOT NULL,
	`tenant_id` int,
	`name` varchar(128) NOT NULL,
	`payload` json NOT NULL,
	`status` enum('pending','processing','completed','failed','dead') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL DEFAULT 5,
	`available_at` timestamp NOT NULL DEFAULT (now()),
	`lease_token` varchar(36),
	`lease_expires_at` datetime,
	`last_error` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int,
	`key` varchar(128) NOT NULL,
	`version` varchar(64) NOT NULL,
	`body` text NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`status` enum('draft','approved','retired') NOT NULL DEFAULT 'draft',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `prompt_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `prompt_versions_key_version_uq` UNIQUE(`key`,`version`)
);
--> statement-breakpoint
CREATE TABLE `role_assignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`tenant_id` int NOT NULL,
	`role_id` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `role_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `role_assignments_user_tenant_role_uq` UNIQUE(`user_id`,`tenant_id`,`role_id`)
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(128) NOT NULL,
	`title` varchar(255) NOT NULL,
	`permissions` json NOT NULL,
	CONSTRAINT `roles_id` PRIMARY KEY(`id`),
	CONSTRAINT `roles_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`key` varchar(128) NOT NULL,
	`value` text,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `settings_tenant_key_uq` UNIQUE(`tenant_id`,`key`)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`status` enum('active','inactive','archived') NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenants_code_uq` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`provider` varchar(32) NOT NULL,
	`external_id` varchar(512) NOT NULL,
	`secret_hash` varchar(128),
	`metadata` json,
	`expires_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `user_identities_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_identities_provider_external_uq` UNIQUE(`provider`,`external_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(320),
	`display_name` varchar(255) NOT NULL,
	`status` enum('active','inactive','archived') NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `users_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `addresses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`company` varchar(255),
	`contact_person` varchar(255),
	`street` varchar(255),
	`zip` varchar(32),
	`city` varchar(255),
	`country` varchar(64) DEFAULT 'DE',
	`phone` varchar(64),
	`email` varchar(320),
	`website` varchar(512),
	`industry_id` int,
	`status` enum('pending','active','inactive','duplicate') NOT NULL DEFAULT 'pending',
	`metadata` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `addresses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`company` varchar(255),
	`email` varchar(320),
	`phone` varchar(64),
	`address_id` int,
	`industry_id` int,
	`address` text,
	`notes` text,
	`tags` json,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `industries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `industries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`customer_id` int,
	`address_id` int,
	`name` varchar(255) NOT NULL,
	`description` text,
	`status` enum('planning','active','completed','cancelled') NOT NULL DEFAULT 'planning',
	`start_date` datetime,
	`end_date` datetime,
	`metadata` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `ai_usage_tenant_created_idx` ON `ai_usage_ledger` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_hash_idx` ON `audit_log` (`hash`);--> statement-breakpoint
CREATE INDEX `event_outbox_dispatch_idx` ON `event_outbox` (`published_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`available_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_name_idx` ON `jobs` (`name`);--> statement-breakpoint
CREATE INDEX `role_assignments_tenant_user_idx` ON `role_assignments` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `user_identities_user_idx` ON `user_identities` (`user_id`);--> statement-breakpoint
CREATE INDEX `addresses_tenant_idx` ON `addresses` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `addresses_city_idx` ON `addresses` (`city`);--> statement-breakpoint
CREATE INDEX `customers_tenant_idx` ON `customers` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `customers_name_idx` ON `customers` (`name`);--> statement-breakpoint
CREATE INDEX `industries_name_idx` ON `industries` (`name`);--> statement-breakpoint
CREATE INDEX `projects_tenant_idx` ON `projects` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `projects_customer_idx` ON `projects` (`customer_id`);