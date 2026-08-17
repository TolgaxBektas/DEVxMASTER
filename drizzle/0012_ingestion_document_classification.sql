CREATE TABLE `ingestion_document_classifications` (
  `id` int NOT NULL AUTO_INCREMENT,
  `tenant_id` int NOT NULL,
  `document_id` int NOT NULL,
  `type` varchar(64) DEFAULT NULL,
  `type_source` varchar(16) NOT NULL DEFAULT 'first-pages',
  `type_confidence` float DEFAULT NULL,
  `publication_name` varchar(255) DEFAULT NULL,
  `publication_name_source` varchar(16) NOT NULL DEFAULT 'first-pages',
  `publication_name_confidence` float DEFAULT NULL,
  `edition_label` varchar(128) DEFAULT NULL,
  `edition_source` varchar(16) NOT NULL DEFAULT 'first-pages',
  `edition_confidence` float DEFAULT NULL,
  `period_start_year` int DEFAULT NULL,
  `period_end_year` int DEFAULT NULL,
  `period_issue` int DEFAULT NULL,
  `period_source` varchar(16) NOT NULL DEFAULT 'first-pages',
  `period_confidence` float DEFAULT NULL,
  `region_place` varchar(255) DEFAULT NULL,
  `region_district` varchar(255) DEFAULT NULL,
  `region_state` varchar(255) DEFAULT NULL,
  `region_source` varchar(16) NOT NULL DEFAULT 'first-pages',
  `region_confidence` float DEFAULT NULL,
  `derived_at` timestamp NULL,
  `corrected_at` timestamp NULL,
  `corrected_by` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ingestion_classifications_tenant_document_uq` (`tenant_id`,`document_id`)
);
--> statement-breakpoint
UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  `permissions`,
  '$',
  'ingestion.document.classify'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"ingestion.document.classify"');
