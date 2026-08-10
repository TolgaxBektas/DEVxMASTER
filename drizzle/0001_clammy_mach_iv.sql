CREATE TABLE `billing_credit_notes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`issuer_id` int NOT NULL,
	`invoice_id` int,
	`credit_number` varchar(64) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`currency` enum('EUR','GBP') NOT NULL,
	`reason` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_credit_notes_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_credit_number_uq` UNIQUE(`tenant_id`,`credit_number`)
);
--> statement-breakpoint
CREATE TABLE `billing_dunning_levels` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`level` int NOT NULL,
	`days_after_due` int NOT NULL,
	`fee_amount` decimal(14,2) NOT NULL,
	`interest_rate` decimal(7,4) NOT NULL,
	`subject` varchar(255) NOT NULL,
	`body_template` text NOT NULL,
	`active` int NOT NULL DEFAULT 1,
	CONSTRAINT `billing_dunning_levels_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_dunning_level_uq` UNIQUE(`tenant_id`,`level`)
);
--> statement-breakpoint
CREATE TABLE `billing_dunning_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`invoice_id` int NOT NULL,
	`level` int NOT NULL,
	`fee_amount` decimal(14,2) NOT NULL,
	`interest_amount` decimal(14,2) NOT NULL,
	`total_due` decimal(14,2) NOT NULL,
	`subject` varchar(255) NOT NULL,
	`body` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_dunning_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_invoice_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoice_id` int NOT NULL,
	`position` int NOT NULL,
	`description` varchar(500) NOT NULL,
	`quantity` decimal(12,2) NOT NULL,
	`unit_price` decimal(14,2) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`commission_rate` decimal(5,2),
	`customer_id` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_invoice_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_invoices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`issuer_id` int NOT NULL,
	`customer_id` int,
	`invoice_number` varchar(64) NOT NULL,
	`status` enum('draft','issued','partially_paid','paid','cancelled') NOT NULL DEFAULT 'draft',
	`currency` enum('EUR','GBP') NOT NULL,
	`vat_treatment` enum('RC','VAT19','VAT0') NOT NULL,
	`subtotal` decimal(14,2) NOT NULL DEFAULT '0.00',
	`vat_rate` decimal(5,2) NOT NULL DEFAULT '0.00',
	`vat_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`total` decimal(14,2) NOT NULL DEFAULT '0.00',
	`paid_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`issue_date` timestamp,
	`due_date` timestamp,
	`recipient_name` varchar(255) NOT NULL,
	`recipient_address` text,
	`recipient_email` varchar(320),
	`notes` text,
	`metadata` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billing_invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_invoice_number_uq` UNIQUE(`tenant_id`,`invoice_number`)
);
--> statement-breakpoint
CREATE TABLE `billing_issuers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`address` text,
	`email` varchar(320),
	`tax_id` varchar(64),
	`invoice_prefix` varchar(20) NOT NULL,
	`next_number` int NOT NULL DEFAULT 1,
	`bank_name` varchar(255),
	`iban` varchar(50),
	`bic` varchar(20),
	`logo_url` text,
	`letterhead` text,
	`currency` enum('EUR','GBP') NOT NULL DEFAULT 'EUR',
	`vat_treatment` enum('RC','VAT19','VAT0') NOT NULL DEFAULT 'RC',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billing_issuers_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_issuers_prefix_uq` UNIQUE(`tenant_id`,`invoice_prefix`)
);
--> statement-breakpoint
CREATE TABLE `billing_payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoice_id` int NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`paid_at` timestamp NOT NULL,
	`reference` varchar(255),
	`note` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `billing_dunning_invoice_idx` ON `billing_dunning_log` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `billing_items_invoice_idx` ON `billing_invoice_items` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `billing_invoices_tenant_idx` ON `billing_invoices` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `billing_issuers_tenant_idx` ON `billing_issuers` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `billing_payments_invoice_idx` ON `billing_payments` (`invoice_id`);