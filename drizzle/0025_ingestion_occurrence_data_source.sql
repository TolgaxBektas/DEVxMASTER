ALTER TABLE `ingestion_occurrences`
  ADD COLUMN IF NOT EXISTS `data_source` varchar(32) NOT NULL DEFAULT 'xdata_germany';
