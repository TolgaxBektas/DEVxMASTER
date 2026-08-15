import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Select,
  Skeleton,
  useModuleQuery,
  type ModulePageProps,
} from "@xmaster-center/ui";

type Occurrence = {
  id: number;
  pageNumber?: number;
  company?: string;
  preview?: string;
  status?: string;
  confidence?: number | null;
  evidence?: string[] | null;
};

const evidenceLabels: Record<string, string> = {
  geometry: "Materielle Fläche",
  logo: "Logo/Signet",
  contact: "Telefonkontakt",
  "page-dominant": "Ganzseitige Fläche",
  "publisher-marking": "Verlagsvermerk „Anzeige“",
  "provenance-uncertain": "Herkunft unklar",
  advertiser: "Werbetreibender",
};
const statusLabels: Record<string, string> = {
  detected: "Offen",
  approved: "Freigegeben",
  rejected: "Abgelehnt",
};

export function OccurrencesPage({ api }: ModulePageProps) {
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState("");
  const occurrences = useModuleQuery<Occurrence[]>(
    api,
    "modules.ingestion.occurrences.list",
  );
  const capabilities = useModuleQuery<{ review: boolean }>(
    api,
    "modules.ingestion.occurrences.capabilities",
  );
  if (occurrences.isLoading || capabilities.isLoading) return <Skeleton />;
  if (occurrences.error || capabilities.error) {
    return <EmptyState title="Fundstellen konnten nicht geladen werden" description="Bitte Anmeldung und Berechtigung prüfen." />;
  }
  const rows = (occurrences.data ?? []).filter((item) =>
    status ? item.status === status : true,
  );
  const review = async (id: number, decision: "approved" | "rejected") => {
    setMessage("");
    try {
      await api.mutate("modules.ingestion.occurrences.review", { id, decision });
      await api.invalidate?.("modules.ingestion.occurrences.list");
      setMessage(decision === "approved" ? "Fundstelle freigegeben." : "Fundstelle abgelehnt.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Entscheidung konnte nicht gespeichert werden.");
    }
  };
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">INGESTION</div>
          <h1>Erkannte Fundstellen</h1>
          <p>Werbung und Kontaktdaten aus verarbeiteten Dokumenten prüfen und entscheiden.</p>
        </div>
      </div>
      <Card>
        <label>Status
          <Select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Alle Fundstellen</option>
            <option value="detected">Offen</option>
            <option value="approved">Freigegeben</option>
            <option value="rejected">Abgelehnt</option>
          </Select>
        </label>
      </Card>
      {message && <p className="form-message" role="status">{message}</p>}
      {!rows.length && <EmptyState title="Keine Fundstellen für diesen Status." />}
      <div className="stack">
        {rows.map((occurrence) => (
          <Card key={occurrence.id}>
            <div style={{ display: "grid", gap: "1.25rem", gridTemplateColumns: "minmax(280px, 1fr) minmax(280px, 1.2fr)" }}>
              <div>
                <img
                  src={`/api/ingestion/occurrences/${occurrence.id}/image`}
                  alt={`Ausschnitt ${occurrence.company ?? "Fundstelle"}`}
                  style={{ width: "100%", maxHeight: "520px", objectFit: "contain", background: "#f4f5f7", borderRadius: "8px" }}
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                    const fallback = event.currentTarget.nextElementSibling;
                    if (fallback instanceof HTMLElement) fallback.hidden = false;
                  }}
                />
                <div hidden className="ui-empty">Ausschnitt nicht verfügbar.</div>
              </div>
              <div className="stack">
                <div className="proposal-meta">
                  <strong>{occurrence.company || "Firma nicht ermittelt"}</strong>
                  {occurrence.pageNumber != null && <span>Seite {occurrence.pageNumber}</span>}
                  <span>Status: {statusLabels[occurrence.status ?? ""] ?? occurrence.status ?? "Offen"}</span>
                  <span>Zuversicht: {occurrence.confidence == null ? "nicht angegeben" : `${Math.round(occurrence.confidence * 100)} %`}</span>
                </div>
                <p>{occurrence.preview || "Keine Vorschau vorhanden."}</p>
                <div>
                  <strong>Belege</strong>
                  <div className="row-actions" style={{ marginTop: "0.5rem" }}>
                    {(occurrence.evidence ?? []).length
                      ? occurrence.evidence?.map((item) => (
                        <Badge key={item} tone={item === "provenance-uncertain" ? "danger" : "neutral"}>
                          {evidenceLabels[item] ?? item}
                        </Badge>
                      ))
                      : <span>Keine Belege gespeichert.</span>}
                  </div>
                </div>
                {occurrence.evidence?.includes("provenance-uncertain") && (
                  <p><strong>Hinweis:</strong> Die Herkunft ist unklar. Bitte prüfen, ob der Werbetreibende zum gewünschten Bestand gehört.</p>
                )}
                {capabilities.data?.review && occurrence.status !== "approved" && (
                  <Button onClick={() => void review(occurrence.id, "approved")}>Freigeben</Button>
                )}
                {capabilities.data?.review && occurrence.status !== "rejected" && (
                  <Button variant="danger" onClick={() => void review(occurrence.id, "rejected")}>Ablehnen</Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
