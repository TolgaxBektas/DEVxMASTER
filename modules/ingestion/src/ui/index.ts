export { IngestionPage } from "./IngestionPage.js";
export { OccurrencesPage } from "./OccurrencesPage.js";
export { SourcesPage } from "./SourcesPage.js";
export const ingestionPages = [
  ["ingestion.sources", "Quellen", "/ingestion/sources", "ingestion.source.read"],
  ["ingestion.documents", "Dokumente", "/ingestion", "ingestion.document.read"],
  ["ingestion.occurrences", "Fundstellen", "/ingestion/occurrences", "ingestion.occurrence.read"],
] as const;
