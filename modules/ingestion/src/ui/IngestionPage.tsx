import { useState } from "react";
import { Button, Card, DataTable, EmptyState, Skeleton, useModuleQuery, type ModulePageProps } from "@xmaster-center/ui";

type Row = { id: number; filename?: string; state?: string; company?: string; preview?: string; status?: string };
export function IngestionPage({ api }: ModulePageProps) {
  const documents = useModuleQuery<Row[]>(api, "modules.ingestion.documents.list");
  const occurrences = useModuleQuery<Row[]>(api, "modules.ingestion.occurrences.list");
  const [message, setMessage] = useState("");
  if (documents.isLoading || occurrences.isLoading) return <Skeleton />;
  if (documents.error || occurrences.error) return <EmptyState title="Ingestion-Daten konnten nicht geladen werden" />;
  const ingest = async () => {
    setMessage("");
    try {
      await api.mutate("modules.ingestion.documents.ingestDemo");
      await api.invalidate?.("modules.ingestion.documents.list");
      await api.invalidate?.("modules.ingestion.occurrences.list");
      setMessage("Beispieldokument aufgenommen");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Dokument konnte nicht aufgenommen werden",
      );
    }
  };
  return <div className="stack">
    {message && <div className="form-message">{message}</div>}
    <div className="page-heading"><div><div className="eyebrow">INGESTION</div><h1>Dokumente & Fundstellen</h1><p>Quelle, Dokument, Verarbeitung und erkannte Anzeigen.</p></div><Button onClick={ingest}>Beispieldokument aufnehmen</Button></div>
    <Card><h2>Dokumente</h2><DataTable rows={documents.data ?? []} columns={[{ key: "filename", label: "Datei" }, { key: "state", label: "Zustand" }]} /></Card>
    <Card><h2>Fundstellen</h2><DataTable rows={occurrences.data ?? []} columns={[{ key: "company", label: "Firma" }, { key: "preview", label: "Vorschau" }, { key: "status", label: "Status" }]} /></Card>
  </div>;
}
