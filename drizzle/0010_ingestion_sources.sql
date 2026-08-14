ALTER TABLE `ingestion_sources`
  MODIFY COLUMN `url` varchar(700) NOT NULL,
  ADD COLUMN `score` float NOT NULL DEFAULT 0,
  ADD COLUMN `metadata` json,
  ADD COLUMN `approved_by` text,
  ADD COLUMN `approved_at` timestamp NULL,
  ADD COLUMN `last_fetched_at` timestamp NULL,
  ADD COLUMN `last_error` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_sources_tenant_url_uq`
  ON `ingestion_sources` (`tenant_id`, `url`);
--> statement-breakpoint
UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  `permissions`,
  '$',
  'ingestion.source.approve',
  'ingestion.source.fetch',
  'ingestion.source.search'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"ingestion.source.approve"');
