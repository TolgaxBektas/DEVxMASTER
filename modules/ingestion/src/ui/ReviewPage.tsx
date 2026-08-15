import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  useModuleQuery,
  type ModulePageProps,
} from "@xmaster-center/ui";

type Review = {
  id: number;
  reason: string;
  page: number | null;
  company: {
    name: string | null;
    extracted_values: Record<string, unknown>;
    evidence: unknown;
  };
  bbox: unknown;
  restoration: {
    review_status: string | null;
    geometry_quality_status: string | null;
    model_name: string | null;
    plan_digest: string | null;
  };
  images: { original_available: boolean; restored_available: boolean };
};

type ReviewQueue = {
  enabled: boolean;
  message?: string;
  items: Review[];
};

type DecisionResult = { next_open_id: number | null };

const FIELD_LABELS: Record<string, string> = {
  company: "Firma",
  phone: "Telefon",
  fax: "Fax",
  email: "E-Mail",
  website: "Domain",
  domain: "Domain",
  address: "Adresse",
  street: "Straße",
  postal_code: "PLZ",
  city: "Ort",
  social: "Social-Kanäle",
  social_channels: "Social-Kanäle",
};

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${FIELD_LABELS[key] ?? key}: ${displayValue(nested)}`)
      .join(" · ");
  }
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function evidenceDetails(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const parts = [
    typeof data.source === "string" ? data.source : null,
    typeof data.source_url === "string" ? data.source_url : null,
    typeof data.retrieved_at === "string" ? data.retrieved_at : null,
    typeof data.verified === "boolean" ? (data.verified ? "belegt" : "nicht belegt") : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : null;
}

function ContactDetails({
  values,
  evidence,
}: {
  values: Record<string, unknown>;
  evidence: unknown;
}) {
  const evidenceMap =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : {};
  const knownKeys = Object.keys(FIELD_LABELS).filter((key) => key in values);
  const restKeys = Object.keys(values).filter((key) => !knownKeys.includes(key));
  const rows = [...knownKeys, ...restKeys];
  if (!rows.length) return <p className="muted">Keine extrahierten Kontaktwerte.</p>;
  return (
    <dl className="detail-list">
      {rows.map((key) => (
        <div key={key}>
          <dt>{FIELD_LABELS[key] ?? key}</dt>
          <dd>
            <strong>{displayValue(values[key])}</strong>
            {evidenceDetails(evidenceMap[key]) && (
              <span className="detail-evidence">{evidenceDetails(evidenceMap[key])}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ReviewPage({ api }: ModulePageProps) {
  const queue = useModuleQuery<ReviewQueue>(api, "modules.ingestion.review.list");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = useModuleQuery<Review>(
    api,
    "modules.ingestion.review.get",
    selectedId ? { id: selectedId } : undefined,
    selectedId !== null,
  );
  const selectedIndex = useMemo(
    () => queue.data?.items.findIndex((item) => item.id === selectedId) ?? -1,
    [queue.data?.items, selectedId],
  );

  useEffect(() => {
    if (selectedId === null && queue.data?.items[0]) setSelectedId(queue.data.items[0].id);
    if (selectedId !== null && queue.data && !queue.data.items.some((item) => item.id === selectedId)) {
      setSelectedId(queue.data.items[0]?.id ?? null);
    }
  }, [queue.data, selectedId]);

  const decide = useCallback(async (decision: "approve" | "reject") => {
    if (selectedId === null || busy) return;
    setBusy(true);
    setDecisionError(null);
    try {
      const result = await api.mutate<DecisionResult>("modules.ingestion.review.decide", {
        id: selectedId,
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNote("");
      await api.invalidate?.("modules.ingestion.review.list");
      setSelectedId(result.next_open_id);
    } catch {
      setDecisionError("Die Entscheidung konnte nicht gespeichert werden. Die Notiz wurde nicht verändert.");
    } finally {
      setBusy(false);
    }
  }, [api, busy, note, selectedId]);

  const next = useCallback(() => {
    const items = queue.data?.items ?? [];
    if (!items.length) return;
    const first = items[0];
    if (!first) return;
    setSelectedId(items[(selectedIndex + 1) % items.length]?.id ?? first.id);
  }, [queue.data?.items, selectedIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.toLowerCase() === "a") void decide("approve");
      if (event.key.toLowerCase() === "r") void decide("reject");
      if (event.key.toLowerCase() === "n") next();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decide, next]);

  if (queue.isLoading) return <Skeleton />;
  if (queue.error) return <EmptyState title="Prüffälle konnten nicht geladen werden" />;
  if (!queue.data?.enabled) {
    return (
      <EmptyState
        title="Prüfung deaktiviert"
        {...(queue.data?.message ? { description: queue.data.message } : {})}
      />
    );
  }
  if (!queue.data.items.length) {
    return <EmptyState title="Keine offenen Prüffälle" description={queue.data.message ?? "Alle Fälle wurden bearbeitet."} />;
  }
  if (selected.isLoading || !selected.data) return <Skeleton />;
  if (selected.error) return <EmptyState title="Prüffall konnte nicht geladen werden" />;

  const review = selected.data;
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">INGESTION</div>
          <h1>Prüfung</h1>
          <p>Original und Bearbeitung manuell freigeben oder ablehnen.</p>
        </div>
        <span className="form-message">A: Freigeben · R: Ablehnen · N: Weiter</span>
      </div>
      <div className="review-layout">
        <Card>
          <h2>Offene Fälle</h2>
          <div className="stack">
            {queue.data.items.map((item) => (
              <button
                className={item.id === review.id ? "list-row active" : "list-row"}
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
              >
                <strong>{item.company.name ?? "Unbekannte Firma"}</strong>
                <span>Seite {item.page ?? "—"} · {item.reason}</span>
              </button>
            ))}
          </div>
        </Card>
        <div className="stack">
          <Card>
            <h2>{review.company.name ?? "Unbekannte Firma"}</h2>
            <p>{review.reason}</p>
            <div className="review-images">
              <figure>
                <figcaption>Original</figcaption>
                {review.images.original_available ? (
                  <img src={`/api/ingestion/reviews/${review.id}/original`} alt="Original" />
                ) : (
                  <div className="image-unavailable">Originalbild nicht verfügbar</div>
                )}
              </figure>
              <figure>
                <figcaption>Bearbeitung</figcaption>
                {review.images.restored_available ? (
                  <img src={`/api/ingestion/reviews/${review.id}/restored`} alt="Bearbeitung" />
                ) : (
                  <div className="image-unavailable">Bearbeitung nicht verfügbar</div>
                )}
              </figure>
              </div>
          </Card>
          <Card>
            <h2>Extrahierte Daten</h2>
            <ContactDetails
              values={review.company.extracted_values}
              evidence={review.company.evidence}
            />
            <dl className="detail-list">
              <dt>Seite</dt><dd>{review.page ?? "—"}</dd>
              <dt>Bounding-Box</dt><dd>{Array.isArray(review.bbox) ? review.bbox.join(" × ") : displayValue(review.bbox)}</dd>
              <dt>Review-Status</dt><dd>{review.restoration.review_status ?? "—"}</dd>
              <dt>Geometrie</dt><dd>{review.restoration.geometry_quality_status ?? "—"}</dd>
              <dt>Modell</dt><dd>{review.restoration.model_name ?? "—"}</dd>
              <dt>Plan-Digest</dt><dd>{review.restoration.plan_digest ?? "—"}</dd>
            </dl>
            <label htmlFor="review-note">Notiz</label>
            <Input id="review-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optionale Notiz" />
            {decisionError && <div className="login-error">{decisionError}</div>}
            <div className="button-row">
              <Button disabled={busy} onClick={() => void decide("approve")}>Freigeben (A)</Button>
              <Button variant="danger" disabled={busy} onClick={() => void decide("reject")}>Ablehnen (R)</Button>
              <Button variant="secondary" disabled={busy} onClick={next}>Weiter (N)</Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
