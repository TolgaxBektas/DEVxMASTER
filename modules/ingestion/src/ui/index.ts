export { IngestionPage } from "./IngestionPage.js";
export { OccurrencesPage } from "./OccurrencesPage.js";
export { SourcesPage } from "./SourcesPage.js";
export { ReviewPage } from "./ReviewPage.js";
export { AreasPage } from "./AreasPage.js";
export const ingestionPages = [
  ["ingestion.sources", "Quellen", "/ingestion/sources", "ingestion.source.read"],
  ["ingestion.areas", "Gebiete", "/ingestion/areas", "ingestion.area.read"],
  ["ingestion.documents", "Dokumente", "/ingestion", "ingestion.document.read"],
  ["ingestion.occurrences", "Fundstellen", "/ingestion/occurrences", "ingestion.occurrence.read"],
  ["ingestion.review", "Prüfung", "/ingestion/review", "ingestion.review.read"],
] as const;
