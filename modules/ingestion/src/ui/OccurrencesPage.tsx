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
import { evidenceLabel } from "../evidence-labels.js";

export { evidenceLabel } from "../evidence-labels.js";

type Occurrence = {
  id: number;
  pageNumber?: number;
  company?: string;
  preview?: string;
  status?: string;
  confidence?: number | null;
  evidence?: string[] | null;
};

type ImageState = "loading" | "loaded" | "missing";

export function occurrenceImageFallbackVisible(state: ImageState): boolean {
  return state === "missing";
}
export function occurrenceExportPath(status: string): string {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return `/api/ingestion/occurrences/export${query}`;
}
export async function downloadOccurrenceExport(
  status: string,
  environment: {
    fetcher?: typeof fetch;
    documentRef?: Pick<Document, "createElement">;
    urlRef?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  } = {},
) {
  const response = await (environment.fetcher ?? fetch)(occurrenceExportPath(status));
  if (!response.ok) throw new Error("Excel-Paket konnte nicht heruntergeladen werden.");
  const blob = await response.blob();
  const urlRef = environment.urlRef ?? URL;
  const link = (environment.documentRef ?? document).createElement("a");
  const objectUrl = urlRef.createObjectURL(blob);
  link.href = objectUrl;
  link.download = "anzeigen.zip";
  link.click();
  urlRef.revokeObjectURL(objectUrl);
}
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
  const downloadExport = async () => {
    setMessage("");
    try {
      await downloadOccurrenceExport(status);
      setMessage("Excel-Paket heruntergeladen.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Excel-Paket konnte nicht heruntergeladen werden.");
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
        <Button variant="secondary" onClick={() => void downloadExport()}>
          Als Excel-Paket herunterladen
        </Button>
      </Card>
      {message && <p className="form-message" role="status">{message}</p>}
      {!rows.length && <EmptyState title="Keine Fundstellen für diesen Status." />}
      <div className="stack">
        {rows.map((occurrence) => (
          <OccurrenceCard key={occurrence.id} occurrence={occurrence} canReview={Boolean(capabilities.data?.review)} review={review} />
        ))}
      </div>
    </div>
  );
}

function OccurrenceCard({
  occurrence,
  canReview,
  review,
}: {
  occurrence: Occurrence;
  canReview: boolean;
  review: (id: number, decision: "approved" | "rejected") => Promise<void>;
}) {
  const [imageState, setImageState] = useState<ImageState>("loading");
  return (
          <Card>
            <div style={{ display: "grid", gap: "1.25rem", gridTemplateColumns: "minmax(280px, 1fr) minmax(280px, 1.2fr)" }}>
              <div>
                <img
                  src={`/api/ingestion/occurrences/${occurrence.id}/image`}
                  alt={`Ausschnitt ${occurrence.company ?? "Fundstelle"}`}
                  onLoad={() => setImageState("loaded")}
                  onError={() => setImageState("missing")}
                  style={{
                    width: "100%",
                    maxHeight: "520px",
                    objectFit: "contain",
                    background: "#f4f5f7",
                    borderRadius: "8px",
                    display: imageState === "missing" ? "none" : "block",
                  }}
                />
                {occurrenceImageFallbackVisible(imageState) && <div className="ui-empty">Ausschnitt nicht verfügbar.</div>}
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
                          {evidenceLabel(item)}
                        </Badge>
                      ))
                      : <span>Keine Belege gespeichert.</span>}
                  </div>
                </div>
                {occurrence.evidence?.includes("provenance-uncertain") && (
                  <p><strong>Hinweis:</strong> Die Herkunft ist unklar. Bitte prüfen, ob der Werbetreibende zum gewünschten Bestand gehört.</p>
                )}
                {canReview && occurrence.status !== "approved" && (
                  <Button onClick={() => void review(occurrence.id, "approved")}>Freigeben</Button>
                )}
                {canReview && occurrence.status !== "rejected" && (
                  <Button variant="danger" onClick={() => void review(occurrence.id, "rejected")}>Ablehnen</Button>
                )}
              </div>
            </div>
          </Card>
  );
}
