ALTER TABLE `ingestion_occurrences`
  ADD `evidence` json;
--> statement-breakpoint
UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  `permissions`,
  '$',
  'ingestion.occurrence.review'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"ingestion.occurrence.review"');
