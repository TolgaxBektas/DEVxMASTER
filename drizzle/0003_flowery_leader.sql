CREATE TABLE `ingestion_documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`source_id` int,
	`filename` varchar(255) NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`state` varchar(32) NOT NULL,
	`error` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ingestion_documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ingestion_occurrences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`document_id` int NOT NULL,
	`page_id` int NOT NULL,
	`company` varchar(255) NOT NULL,
	`preview` text NOT NULL,
	`status` varchar(32) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ingestion_occurrences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ingestion_pages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`document_id` int NOT NULL,
	`page_number` int NOT NULL,
	`text` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ingestion_pages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ingestion_sources` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` int NOT NULL,
	`url` text NOT NULL,
	`status` varchar(32) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ingestion_sources_id` PRIMARY KEY(`id`)
);
