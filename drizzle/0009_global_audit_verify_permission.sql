UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  `permissions`,
  '$',
  'system.audit.global.verify'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"system.audit.global.verify"');
