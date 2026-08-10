ALTER TABLE `ingestion_documents` ADD `storage_key` varchar(1024);--> statement-breakpoint
ALTER TABLE `ingestion_documents` ADD `size_bytes` int;--> statement-breakpoint
ALTER TABLE `ingestion_documents` ADD `mime_type` varchar(128);--> statement-breakpoint
ALTER TABLE `ingestion_documents` ADD `origin` varchar(32);--> statement-breakpoint
UPDATE `ingestion_documents` SET `storage_key` = CONCAT('legacy/', `id`), `size_bytes` = 0, `mime_type` = 'application/pdf', `origin` = 'legacy' WHERE `storage_key` IS NULL;--> statement-breakpoint
ALTER TABLE `ingestion_documents` MODIFY `storage_key` varchar(1024) NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_documents` MODIFY `size_bytes` int NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_documents` MODIFY `mime_type` varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_documents` MODIFY `origin` varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE `ingestion_occurrences` ADD `bbox` json;--> statement-breakpoint
ALTER TABLE `ingestion_occurrences` ADD `image_key` varchar(1024);--> statement-breakpoint
ALTER TABLE `ingestion_occurrences` ADD `confidence` float;--> statement-breakpoint
ALTER TABLE `ingestion_pages` ADD `image_key` varchar(1024);--> statement-breakpoint
ALTER TABLE `ingestion_pages` ADD `classification` varchar(64);--> statement-breakpoint
ALTER TABLE `ingestion_pages` ADD `ad_probability` float;