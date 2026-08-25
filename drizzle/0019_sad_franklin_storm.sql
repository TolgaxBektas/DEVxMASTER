CREATE TABLE `billing_quote_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`quote_id` int NOT NULL,
	`position` int NOT NULL,
	`description` varchar(500) NOT NULL,
	`quantity` decimal(12,2) NOT NULL,
	`unit_price` decimal(14,2) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`commission_rate` decimal(5,2),
	`customer_id` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_quote_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_quotes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`issuer_id` int NOT NULL,
	`customer_id` int,
	`occurrence_id` int,
	`ad_image_key` varchar(1024),
	`quote_number` varchar(64) NOT NULL,
	`status` enum('draft','sent','accepted','declined') NOT NULL DEFAULT 'draft',
	`currency` enum('EUR','GBP') NOT NULL,
	`vat_treatment` enum('RC','VAT19','VAT0') NOT NULL,
	`subtotal` decimal(14,2) NOT NULL DEFAULT '0.00',
	`vat_rate` decimal(5,2) NOT NULL DEFAULT '0.00',
	`vat_amount` decimal(14,2) NOT NULL DEFAULT '0.00',
	`total` decimal(14,2) NOT NULL DEFAULT '0.00',
	`valid_until` timestamp,
	`recipient_name` varchar(255) NOT NULL,
	`recipient_address` text,
	`recipient_email` varchar(320),
	`invoice_id` int,
	`notes` text,
	`metadata` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billing_quotes_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_quote_number_uq` UNIQUE(`tenant_id`,`quote_number`)
);
--> statement-breakpoint
ALTER TABLE `billing_issuers` ADD `quote_prefix` varchar(20);--> statement-breakpoint
ALTER TABLE `billing_issuers` ADD `next_quote_number` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_issuers` ADD `quote_number_year` int;--> statement-breakpoint
CREATE INDEX `billing_items_quote_idx` ON `billing_quote_items` (`quote_id`);--> statement-breakpoint
CREATE INDEX `billing_quotes_tenant_idx` ON `billing_quotes` (`tenant_id`);
--> statement-breakpoint
UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  `permissions`,
  '$', 'billing.quote.read'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"billing.quote.read"');
--> statement-breakpoint
UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  `permissions`,
  '$', 'billing.quote.write'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"billing.quote.write"');
--> statement-breakpoint
UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  `permissions`,
  '$', 'billing.quote.send'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"billing.quote.send"');
--> statement-breakpoint
UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  `permissions`,
  '$', 'billing.quote.accept'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"billing.quote.accept"');