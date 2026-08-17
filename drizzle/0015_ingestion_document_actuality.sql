ALTER TABLE `ingestion_document_classifications`
  ADD `actuality_status` varchar(16);
--> statement-breakpoint
ALTER TABLE `ingestion_document_classifications`
  ADD `actuality_decided_at` timestamp;
--> statement-breakpoint
ALTER TABLE `ingestion_document_classifications`
  ADD `actuality_decided_by` varchar(255);
