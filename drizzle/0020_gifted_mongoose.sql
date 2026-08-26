CREATE TABLE `ingestion_areas` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`level` varchar(16) NOT NULL,
	`ags` varchar(5) NOT NULL,
	`name` varchar(255) NOT NULL,
	`state_name` varchar(255) NOT NULL,
	`order_index` int NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`last_run_at` timestamp,
	`next_due_at` timestamp,
	`last_error` text,
	`found_sources` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ingestion_areas_id` PRIMARY KEY(`id`),
	CONSTRAINT `ingestion_areas_tenant_ags_uq` UNIQUE(`tenant_id`,`ags`)
);
--> statement-breakpoint
CREATE TABLE `ingestion_source_visits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`source_id` int NOT NULL,
	`checked_at` timestamp NOT NULL DEFAULT (now()),
	`http_status` int,
	`new_pdf_count` int NOT NULL DEFAULT 0,
	`changed` boolean NOT NULL DEFAULT false,
	`note` text,
	CONSTRAINT `ingestion_source_visits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ingestion_sources` ADD `area_id` int;--> statement-breakpoint
ALTER TABLE `ingestion_sources` ADD `revisit_interval_days` int DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_sources` ADD `next_check_at` timestamp;--> statement-breakpoint
ALTER TABLE `ingestion_sources` ADD `productive` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_sources` ADD `fingerprint` varchar(255);--> statement-breakpoint
CREATE INDEX `ingestion_areas_tenant_idx` ON `ingestion_areas` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `ingestion_source_visits_tenant_source_idx` ON `ingestion_source_visits` (`tenant_id`,`source_id`);
--> statement-breakpoint
UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(`permissions`, '$', 'ingestion.area.read')
WHERE `code` = 'admin' AND NOT JSON_CONTAINS(`permissions`, '"ingestion.area.read"');
--> statement-breakpoint
UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(`permissions`, '$', 'ingestion.area.run')
WHERE `code` = 'admin' AND NOT JSON_CONTAINS(`permissions`, '"ingestion.area.run"');