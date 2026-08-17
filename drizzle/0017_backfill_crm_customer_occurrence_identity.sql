UPDATE `customers` AS c
JOIN (
  SELECT `tenant_id`, `occurrence_id`
  FROM (
    SELECT
      `tenant_id`,
      CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(`notes`, 'Fundstelle ', -1), ':', 1) AS UNSIGNED) AS `occurrence_id`,
      COUNT(*) AS `matches`
    FROM `customers`
    WHERE `source_occurrence_id` IS NULL
      AND JSON_CONTAINS(`tags`, JSON_QUOTE('ingestion'))
      AND `notes` REGEXP 'Fundstelle [0-9]+:'
    GROUP BY `tenant_id`, `occurrence_id`
  ) AS candidates
  WHERE `matches` = 1
) AS unique_candidates
  ON unique_candidates.`tenant_id` = c.`tenant_id`
 AND unique_candidates.`occurrence_id` =
   CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(c.`notes`, 'Fundstelle ', -1), ':', 1) AS UNSIGNED)
SET c.`source_occurrence_id` = unique_candidates.`occurrence_id`
WHERE c.`source_occurrence_id` IS NULL
  AND JSON_CONTAINS(c.`tags`, JSON_QUOTE('ingestion'))
  AND c.`notes` REGEXP 'Fundstelle [0-9]+:';
