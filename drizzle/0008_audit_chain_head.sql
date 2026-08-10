CREATE TABLE `audit_chain_heads` (
  `id` tinyint NOT NULL,
  `seq` int NOT NULL,
  `hash` varchar(64) NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `audit_chain_heads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
INSERT INTO `audit_chain_heads` (`id`, `seq`, `hash`)
SELECT
  1,
  COALESCE(MAX(`seq`), 0),
  COALESCE(
    (SELECT `hash` FROM `audit_log` ORDER BY `seq` DESC LIMIT 1),
    REPEAT('0', 64)
  )
FROM `audit_log`;
