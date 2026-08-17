UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  `permissions`,
  '$', 'ingestion.review.read'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"ingestion.review.read"');
--> statement-breakpoint
UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  `permissions`,
  '$', 'ingestion.review.decide'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"ingestion.review.decide"');
