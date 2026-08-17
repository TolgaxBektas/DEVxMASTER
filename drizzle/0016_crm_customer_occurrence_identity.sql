ALTER TABLE `customers`
  ADD `source_occurrence_id` int;
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_source_occurrence_idx`
  ON `customers` (`tenant_id`, `source_occurrence_id`);
