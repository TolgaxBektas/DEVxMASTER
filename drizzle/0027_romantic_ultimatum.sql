CREATE TABLE `ingestion_search_keys` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`area_id` int NOT NULL,
	`key_type` varchar(16) NOT NULL,
	`term` varchar(120) NOT NULL,
	`scope` varchar(255) NOT NULL,
	`query` varchar(255) NOT NULL,
	`status` varchar(16) NOT NULL DEFAULT 'pending',
	`last_searched_at` timestamp,
	`next_due_at` timestamp,
	`last_hit_count` int NOT NULL DEFAULT 0,
	`last_pdf_count` int NOT NULL DEFAULT 0,
	`last_new_sources` int NOT NULL DEFAULT 0,
	`total_new_sources` int NOT NULL DEFAULT 0,
	`run_count` int NOT NULL DEFAULT 0,
	`last_error` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ingestion_search_keys_id` PRIMARY KEY(`id`),
	CONSTRAINT `ingestion_search_keys_tenant_query_uq` UNIQUE(`tenant_id`,`query`)
);
--> statement-breakpoint
CREATE TABLE `ingestion_search_terms` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`term` varchar(120) NOT NULL,
	`priority` int NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`origin` varchar(16) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ingestion_search_terms_id` PRIMARY KEY(`id`),
	CONSTRAINT `ingestion_search_terms_tenant_term_uq` UNIQUE(`tenant_id`,`term`)
);
--> statement-breakpoint
CREATE INDEX `ingestion_search_keys_tenant_status_due_idx` ON `ingestion_search_keys` (`tenant_id`,`status`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `ingestion_search_keys_tenant_area_idx` ON `ingestion_search_keys` (`tenant_id`,`area_id`);