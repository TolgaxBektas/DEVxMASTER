export { IngestionPage } from "./IngestionPage.js";
export { OccurrencesPage } from "./OccurrencesPage.js";
export const ingestionPages = [
  ["ingestion.documents", "Dokumente", "/ingestion", "ingestion.document.read"],
  ["ingestion.occurrences", "Fundstellen", "/ingestion/occurrences", "ingestion.occurrence.read"],
] as const;
