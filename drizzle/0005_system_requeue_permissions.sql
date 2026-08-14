UPDATE `roles`
SET `permissions` = JSON_ARRAY_APPEND(
  JSON_ARRAY_APPEND(
    JSON_ARRAY_APPEND(
      `permissions`,
      '$',
      'system.jobs.requeue'
    ),
    '$',
    'system.events.read'
  ),
  '$',
  'system.events.requeue'
)
WHERE `code` = 'admin'
  AND NOT JSON_CONTAINS(`permissions`, '"system.jobs.requeue"');
