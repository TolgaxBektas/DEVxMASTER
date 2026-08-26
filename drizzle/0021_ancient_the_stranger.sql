ALTER TABLE `ingestion_areas` ADD `kind` varchar(64) DEFAULT 'Kreis' NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_areas` ADD `started_at` timestamp;