ALTER TABLE `ingestion_document_classifications`
  MODIFY `type_source` varchar(16) NULL,
  MODIFY `publication_name_source` varchar(16) NULL,
  MODIFY `edition_source` varchar(16) NULL,
  MODIFY `period_source` varchar(16) NULL,
  MODIFY `region_source` varchar(16) NULL;
