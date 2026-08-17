ALTER TABLE `billing_issuers` ADD `number_year` int;--> statement-breakpoint
ALTER TABLE `billing_issuers` ADD `payment_term_days` int DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_dunning_log` ADD CONSTRAINT `billing_dunning_invoice_level_uq` UNIQUE(`tenant_id`,`invoice_id`,`level`);
--> statement-breakpoint
UPDATE `billing_issuers` AS i
LEFT JOIN (
  SELECT issuer_id,
    MAX(CAST(SUBSTRING_INDEX(invoice_number, '-', -1) AS UNSIGNED)) AS max_number,
    MAX(YEAR(issue_date)) AS invoice_year
  FROM `billing_invoices`
  GROUP BY issuer_id
) AS existing ON existing.issuer_id = i.id
SET i.number_year = COALESCE(existing.invoice_year, YEAR(CURRENT_DATE)),
    i.next_number = COALESCE(existing.max_number + 1, i.next_number);