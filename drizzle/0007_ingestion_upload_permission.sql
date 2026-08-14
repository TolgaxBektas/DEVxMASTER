UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(`permissions`, '$', 'ingestion.document.upload')
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"ingestion.document.upload"');
