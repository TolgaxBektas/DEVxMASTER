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

type OccurrenceProvenance = {
  occurrenceId: number;
  dataSource: string;
  company: string;
  status: string;
  confidence: number | null;
  bbox: { x: number; y: number; width: number; height: number } | null;
  imageKey: string | null;
  evidence: string[];
  advertiserProof: string[];
  page: { id: number; number: number | null };
  document: { id: number; filename: string; sha256: string; origin: string; storageKey: string };
  source: { id: number; url: string } | null;
  area: { id: number; ags: string; name: string; stateName: string } | null;
  publication: {
    type: string | null;
    name: string | null;
    editionLabel: string | null;
    periodStartYear: number | null;
    periodEndYear: number | null;
    periodIssue: number | null;
  } | null;
};

export type ProvenanceDisplayRow = { label: string; value: string };

export function formatOccurrenceProvenance(provenance: OccurrenceProvenance): ProvenanceDisplayRow[] {
  const publication = provenance.publication;
  const period = [
    publication?.periodStartYear != null && publication.periodEndYear != null
      ? `${publication.periodStartYear}–${publication.periodEndYear}`
      : publication?.periodStartYear ?? publication?.periodEndYear,
    publication?.periodIssue != null ? `Ausgabennummer ${publication.periodIssue}` : null,
  ].filter((value): value is string | number => value != null).join(" · ");
  const dataSourceLabels: Record<string, string> = {
    xdata_germany: "xDATA Germany",
    xdata_nb_high_quality: "xDATA-nB High Quality",
  };
  const dataSource = dataSourceLabels[provenance.dataSource] ?? provenance.dataSource;
  return [
    {
      label: "Gebiet",
      value: provenance.area
        ? `${provenance.area.name} · AGS ${provenance.area.ags} · ${provenance.area.stateName}`
        : "nicht angegeben",
    },
    { label: "Quelle", value: provenance.source?.url ?? "nicht angegeben" },
    {
      label: "Heft",
      value: publication
        ? [publication.name, publication.editionLabel, period].filter(Boolean).join(" · ") || "nicht angegeben"
        : "nicht angegeben",
    },
    {
      label: "Seite",
      value: provenance.page.number == null ? "nicht angegeben" : String(provenance.page.number),
    },
    { label: "Datenquelle", value: dataSource || "nicht angegeben" },
    { label: "Dokument-SHA-256", value: provenance.document.sha256.slice(0, 12) || "nicht angegeben" },
    {
      label: "Inserenten-Nachweis",
      value: provenance.advertiserProof.length
        ? provenance.advertiserProof.map(evidenceLabel).join(", ")
        : "Kein Inserenten-Nachweis (Altfund)",
    },
  ];
}

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
          <OccurrenceCard
            key={occurrence.id}
            api={api}
            occurrence={occurrence}
            canReview={Boolean(capabilities.data?.review)}
            review={review}
          />
        ))}
      </div>
    </div>
  );
}

function OccurrenceCard({
  api,
  occurrence,
  canReview,
  review,
}: {
  api: ModulePageProps["api"];
  occurrence: Occurrence;
  canReview: boolean;
  review: (id: number, decision: "approved" | "rejected") => Promise<void>;
}) {
  const [imageState, setImageState] = useState<ImageState>("loading");
  const provenance = useModuleQuery<OccurrenceProvenance>(
    api,
    "modules.ingestion.occurrences.provenance",
    { id: occurrence.id },
  );
  const provenanceRows = provenance.data ? formatOccurrenceProvenance(provenance.data) : [];
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
                <div>
                  <strong>Herkunft</strong>
                  {provenance.isLoading && <p className="form-message">Herkunft wird geladen …</p>}
                  {provenance.error && <p className="form-message">Herkunft konnte nicht geladen werden.</p>}
                  {provenance.data && (
                    <dl className="detail-list">
                      {provenanceRows.map((row) => (
                        <div key={row.label}>
                          <dt>{row.label}</dt>
                          <dd>{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
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
