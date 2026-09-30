import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  useModuleQuery,
  type ModulePageProps,
} from "@xmaster-center/ui";
import { evidenceLabel } from "../evidence-labels.js";
import type { PifReviewSummary } from "../review-client.js";

type Review = {
  id: number;
  reason: string;
  data_source: DataSource;
  page: number | null;
  advertiser_proof?: string[];
  provenance?: {
    area_name?: string;
    area_ags?: string;
    area_state?: string;
    source_url?: string;
    document_filename?: string;
    publication?: string;
    edition?: string;
    year?: number;
    issue?: number;
  } | null;
  company: {
    name: string | null;
    extracted_values: Record<string, unknown>;
    evidence: unknown;
    verification: {
      verified?: boolean;
      reason?: string;
      sources?: string[];
    };
    deferred_channels: readonly DeferredChannel[];
  };
  bbox: unknown;
  restoration: {
    review_status: string | null;
    geometry_quality_status: string | null;
    model_name: string | null;
    plan_digest: string | null;
    content_comparison?: {
      status: string;
      severity?: string;
      findings: Array<{ type: string; severity?: string; category: string; value: string }>;
    } | null;
    visual_comparison?: {
      alignment?: { class?: string; score?: number };
      lost_cells?: number;
      added_cells?: number;
    } | null;
  };
  images: { original_available: boolean; restored_available: boolean };
};

type ReviewQueue = {
  enabled: boolean;
  message?: string;
  items: Review[];
};

type ReviewSummary = PifReviewSummary & {
  enabled: boolean;
  message?: string;
};

type DataSource = "xdata_nb_high_quality" | "xdata_germany";

type DeferredChannel = {
  id: number;
  field_name: string;
  value: string;
  source_url: string | null;
  retrieved_at: string | null;
  data_source: DataSource;
  status: "waiting_for_x_core" | "transferred_to_x_core";
};

type DecisionResult = { next_open_id: number | null };

const REVIEW_PAGE_SIZE = 100;

const SOURCE_LABELS: Record<DataSource, string> = {
  xdata_nb_high_quality: "xDATA-nB High Quality",
  xdata_germany: "xDATA Germany",
};

export type ReviewTabState = {
  areaAgs: Partial<Record<DataSource, string>>;
  page: Partial<Record<DataSource, number>>;
  selectedIds: Partial<Record<DataSource, number | null>>;
};

export function reviewTabStateFor(state: ReviewTabState, source: DataSource) {
  return {
    areaAgs: state.areaAgs[source] ?? "",
    page: state.page[source] ?? 0,
    selectedId: state.selectedIds[source] ?? null,
  };
}

export function updateReviewArea(
  state: ReviewTabState,
  source: DataSource,
  areaAgs: string,
): ReviewTabState {
  return {
    areaAgs: { ...state.areaAgs, [source]: areaAgs },
    page: { ...state.page, [source]: 0 },
    selectedIds: { ...state.selectedIds, [source]: null },
  };
}

export function updateReviewPage(
  state: ReviewTabState,
  source: DataSource,
  page: number,
): ReviewTabState {
  return {
    ...state,
    page: { ...state.page, [source]: page },
    selectedIds: { ...state.selectedIds, [source]: null },
  };
}

export function updateReviewSelection(
  state: ReviewTabState,
  source: DataSource,
  id: number | null,
): ReviewTabState {
  return {
    ...state,
    selectedIds: { ...state.selectedIds, [source]: id },
  };
}

export function reviewListQueryInput(state: ReviewTabState, source: DataSource) {
  const { areaAgs, page } = reviewTabStateFor(state, source);
  return {
    ...(areaAgs ? { area_ags: areaAgs } : {}),
    limit: REVIEW_PAGE_SIZE,
    offset: page * REVIEW_PAGE_SIZE,
  };
}

const FIELD_LABELS: Record<string, string> = {
  company: "Firma",
  phone: "Telefon",
  fax: "Fax",
  email: "E-Mail",
  website: "Domain",
  domain: "Domain",
  emails: "E-Mail",
  phones: "Telefon",
  faxes: "Fax",
  social_profiles: "Social-Kanäle",
  facebook: "Facebook",
  instagram: "Instagram",
  address: "Adresse",
  street: "Straße",
  postal_code: "PLZ",
  city: "Ort",
  social: "Social-Kanäle",
  social_channels: "Social-Kanäle",
};

export function reviewAreaOptions(
  areas: readonly PifReviewSummary["areas"][number][],
  total: number,
) {
  return [
    { value: "", label: `Alle Gebiete (${total})`, disabled: false },
    ...areas.map((area) => {
      if (area.area_ags === null) {
        return {
          value: "__without_area__",
          label: `ohne Gebiet · ${area.count}`,
          disabled: true,
        };
      }
      const validAgs = /^\d{5}$/.test(area.area_ags);
      return {
        value: validAgs ? area.area_ags : `__invalid__:${area.area_ags}`,
        label: `${area.area_name ?? "Gebiet"} (${area.area_ags}) · ${area.count}`,
        disabled: !validAgs,
      };
    }),
  ];
}

export function reviewPageRange(page: number, total: number, pageSize = REVIEW_PAGE_SIZE) {
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = total === 0 ? 0 : Math.min((page + 1) * pageSize, total);
  return `${start}–${end} von ${total}`;
}

export function ignoresReviewKeyboardShortcut(tagName: string) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(tagName.toUpperCase());
}

export function shortcutsBlocked({
  loading,
  selectedMatches,
  msSinceNavigation,
}: {
  loading: boolean;
  selectedMatches: boolean;
  msSinceNavigation: number;
}): boolean {
  return loading || !selectedMatches || msSinceNavigation < 500;
}

export function resolveSelectedReviewId(
  items: readonly Pick<Review, "id">[],
  preferredId: number | null,
): number | null {
  if (preferredId !== null && items.some((item) => item.id === preferredId)) {
    return preferredId;
  }
  return items[0]?.id ?? null;
}

export function shouldResetDraft(previousId: number | null, nextId: number | null): boolean {
  return previousId !== nextId;
}

export function reviewStatePage({
  pageHeader,
  sourceTabs,
  reviewControls,
  content,
  showReviewControls,
}: {
  pageHeader: ReactNode;
  sourceTabs: ReactNode;
  reviewControls: ReactNode;
  content: ReactNode;
  showReviewControls: boolean;
}): ReactNode {
  return (
    <div className="stack">
      {pageHeader}
      {sourceTabs}
      {showReviewControls && reviewControls}
      {content}
    </div>
  );
}

export function reviewListCaption(
  item: Pick<Review, "page" | "reason" | "provenance">,
): string {
  const area = item.provenance?.area_name;
  return `${area ? `${area} · ` : ""}Seite ${item.page ?? "—"} · ${item.reason}`;
}

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
  if (Array.isArray(value)) {
    const details = value.map(evidenceDetails).filter((part): part is string => Boolean(part));
    return details.length ? details.join(" · ") : null;
  }
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

function VerificationDetails({
  verification,
}: {
  verification: { verified?: boolean; reason?: string; sources?: string[] };
}) {
  const status = verification.verified === true
    ? "belegt"
    : verification.verified === false
      ? "nicht belegt"
      : "nicht angegeben";
  return (
    <div className="verification-row">
      <strong>Belegstatus: {status}</strong>
      {verification.reason && <span>{verification.reason}</span>}
      {verification.sources?.length ? (
        <span>Quellen: {verification.sources.join(" · ")}</span>
      ) : null}
    </div>
  );
}

export function AdvertiserProofDetails({
  advertiserProof,
}: {
  advertiserProof?: string[];
}) {
  return (
    <div className="verification-row">
      <strong>Inserenten-Nachweis</strong>
      {advertiserProof?.length ? (
        advertiserProof.map((proof, index) => (
          <span key={`${proof}-${index}`}>{evidenceLabel(proof)}</span>
        ))
      ) : (
        <span>kein Nachweis übermittelt</span>
      )}
    </div>
  );
}

function joinedDetails(values: Array<string | number | undefined>): string {
  return values
    .filter((value): value is string | number => value !== undefined && value !== "")
    .map(String)
    .join(" · ");
}

export function ReviewProvenanceRows({
  provenance,
}: {
  provenance?: Review["provenance"];
}) {
  const area = joinedDetails([
    provenance?.area_name,
    provenance?.area_ags ? `AGS ${provenance.area_ags}` : undefined,
    provenance?.area_state,
  ]);
  const issue = joinedDetails([
    provenance?.publication,
    provenance?.edition,
    provenance?.year,
    provenance?.issue === undefined ? undefined : `Nr. ${provenance.issue}`,
  ]);
  return (
    <>
      <div><dt>Gebiet</dt><dd>{area || "—"}</dd></div>
      <div>
        <dt>Quelle</dt>
        <dd>
          {provenance?.source_url ? (
            <a href={provenance.source_url} target="_blank" rel="noreferrer">
              {provenance.source_url}
            </a>
          ) : "—"}
        </dd>
      </div>
      <div><dt>Heft</dt><dd>{issue || "—"}</dd></div>
      <div><dt>Datei</dt><dd>{provenance?.document_filename || "—"}</dd></div>
    </>
  );
}

function DeferredChannels({ channels }: { channels: readonly DeferredChannel[] }) {
  if (!channels.length) return null;
  return (
    <div className="verification-row">
      <strong>Zusatzkanäle – wartet auf Feld in X-Core</strong>
      {channels.map((channel) => (
        <span key={channel.id}>
          {FIELD_LABELS[channel.field_name] ?? channel.field_name}: {channel.value}
          {channel.source_url ? ` · ${channel.source_url}` : ""}
        </span>
      ))}
    </div>
  );
}

export function ReviewPage({ api }: ModulePageProps) {
  const [activeSource, setActiveSource] = useState<DataSource>("xdata_nb_high_quality");
  const [sourceState, setSourceState] = useState<ReviewTabState>({
    areaAgs: {},
    page: {},
    selectedIds: {},
  });
  const activeTab = reviewTabStateFor(sourceState, activeSource);
  const { areaAgs, page } = activeTab;
  const highQualitySummary = useModuleQuery<ReviewSummary>(
    api,
    "modules.ingestion.review.summary",
    { data_source: "xdata_nb_high_quality" },
  );
  const germanySummary = useModuleQuery<ReviewSummary>(
    api,
    "modules.ingestion.review.summary",
    { data_source: "xdata_germany" },
  );
  const highQualityListInput = reviewListQueryInput(sourceState, "xdata_nb_high_quality");
  const germanyListInput = reviewListQueryInput(sourceState, "xdata_germany");
  const highQualityQueue = useModuleQuery<ReviewQueue>(
    api,
    "modules.ingestion.review.list",
    { ...highQualityListInput, data_source: "xdata_nb_high_quality" },
  );
  const germanyQueue = useModuleQuery<ReviewQueue>(
    api,
    "modules.ingestion.review.list",
    { ...germanyListInput, data_source: "xdata_germany" },
  );
  const queue = activeSource === "xdata_nb_high_quality" ? highQualityQueue : germanyQueue;
  const summary = activeSource === "xdata_nb_high_quality" ? highQualitySummary : germanySummary;
  const summaryTotal = summary.data?.total ?? 0;
  const selectedArea = areaAgs
    ? summary.data?.areas.find((area) => area.area_ags === areaAgs)
    : undefined;
  const total = areaAgs ? selectedArea?.count ?? 0 : summaryTotal;
  const selectedId = resolveSelectedReviewId(
    queue.data?.items ?? [],
    activeTab.selectedId,
  );
  const previousSelectedId = useRef(selectedId);
  const lastNavigationAt = useRef(0);
  const [note, setNote] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = useModuleQuery<Review>(
    api,
    "modules.ingestion.review.get",
    selectedId ? { id: selectedId } : undefined,
    selectedId !== null,
  );
  const selectedMatches = selected.data?.id === selectedId;
  const selectedIndex = useMemo(
    () => queue.data?.items.findIndex((item) => item.id === selectedId) ?? -1,
    [queue.data?.items, selectedId],
  );

  useEffect(() => {
    const previousId = previousSelectedId.current;
    previousSelectedId.current = selectedId;
    if (!shouldResetDraft(previousId, selectedId)) return;
    setNote("");
    setDecisionError(null);
  }, [selectedId]);

  useEffect(() => {
    if (
      areaAgs
      && summary.data
      && !summary.data.areas.some((area) => area.area_ags === areaAgs)
    ) {
      lastNavigationAt.current = Date.now();
      setSourceState((current) => updateReviewArea(current, activeSource, ""));
    }
  }, [activeSource, areaAgs, summary.data]);

  useEffect(() => {
    if (page > 0 && page * REVIEW_PAGE_SIZE >= total) {
      lastNavigationAt.current = Date.now();
      setSourceState((current) =>
        updateReviewPage(
          current,
          activeSource,
          Math.max(0, Math.ceil(total / REVIEW_PAGE_SIZE) - 1),
        ),
      );
    }
  }, [activeSource, page, total]);

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
      await api.invalidate?.("modules.ingestion.review.summary");
      setSourceState((current) =>
        updateReviewSelection(current, activeSource, result.next_open_id),
      );
    } catch {
      setDecisionError("Die Entscheidung konnte nicht gespeichert werden. Die Notiz wurde nicht verändert.");
    } finally {
      setBusy(false);
    }
  }, [activeSource, api, busy, note, selectedId]);

  const next = useCallback(() => {
    const items = queue.data?.items ?? [];
    if (!items.length) return;
    const first = items[0];
    if (!first) return;
    setSourceState((current) =>
      updateReviewSelection(
        current,
        activeSource,
        items[(selectedIndex + 1) % items.length]?.id ?? first.id,
      ),
    );
  }, [activeSource, queue.data?.items, selectedIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && ignoresReviewKeyboardShortcut(event.target.tagName)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (
        shortcutsBlocked({
          loading: queue.isFetching,
          selectedMatches,
          msSinceNavigation: Date.now() - lastNavigationAt.current,
        })
      ) return;
      if (event.key.toLowerCase() === "a") void decide("approve");
      if (event.key.toLowerCase() === "r") void decide("reject");
      if (event.key.toLowerCase() === "n") next();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decide, next, queue.isFetching, selectedMatches]);

  const pageHeader = (
    <div className="page-heading">
      <div>
        <div className="eyebrow">INGESTION</div>
        <h1>Prüfung</h1>
        <p>Original und Bearbeitung manuell freigeben oder ablehnen.</p>
      </div>
      <span className="form-message">A: Freigeben · R: Ablehnen · N: Weiter</span>
    </div>
  );
  const sourceTabs = (
    <div className="review-source-tabs" role="tablist" aria-label="Datenquelle">
      {(Object.keys(SOURCE_LABELS) as DataSource[]).map((source) => {
        const sourceSummary = source === "xdata_nb_high_quality" ? highQualitySummary : germanySummary;
        return (
          <button
            className={activeSource === source ? "source-tab active" : "source-tab"}
            key={source}
            type="button"
            role="tab"
            aria-selected={activeSource === source}
            onClick={() => setActiveSource(source)}
          >
            {SOURCE_LABELS[source]} ({sourceSummary.data?.total ?? 0})
          </button>
        );
      })}
    </div>
  );
  const areaOptions = reviewAreaOptions(summary.data?.areas ?? [], summaryTotal);
  const reviewControls = (
    <div className="button-row">
      <label htmlFor="review-area">Gebiet</label>
      <select
        className="ui-input"
        id="review-area"
        value={areaAgs}
        onChange={(event) => {
          lastNavigationAt.current = Date.now();
          setSourceState((current) =>
            updateReviewArea(current, activeSource, event.target.value),
          );
        }}
      >
        {areaOptions.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <Button
        disabled={page === 0}
        onClick={() => {
          lastNavigationAt.current = Date.now();
          setSourceState((current) => updateReviewPage(current, activeSource, Math.max(0, page - 1)))
        }}
      >
        Vorherige
      </Button>
      <span className="form-message">{reviewPageRange(page, total)}</span>
      <Button
        disabled={(page + 1) * REVIEW_PAGE_SIZE >= total}
        onClick={() => {
          lastNavigationAt.current = Date.now();
          setSourceState((current) => updateReviewPage(current, activeSource, page + 1))
        }}
      >
        Nächste
      </Button>
    </div>
  );
  const statePage = (content: ReactNode, showReviewControls = Boolean(summary.data)) =>
    reviewStatePage({
      pageHeader,
      sourceTabs,
      reviewControls,
      content,
      showReviewControls,
    });

  if (queue.isLoading || summary.isLoading) return statePage(<Skeleton />);
  if (queue.error || summary.error) {
    return statePage(<EmptyState title="Prüffälle konnten nicht geladen werden" />);
  }
  if (!queue.data?.enabled) {
    return statePage(
      <EmptyState
        title="Prüfung deaktiviert"
        {...(queue.data?.message ? { description: queue.data.message } : {})}
      />,
    );
  }
  if (!queue.data.items.length) {
    return statePage(
      <EmptyState
        title="Keine offenen Prüffälle"
        description={queue.data.message ?? "Alle Fälle wurden bearbeitet."}
      />,
      true,
    );
  }
  if (selected.error) {
    return statePage(<EmptyState title="Prüffall konnte nicht geladen werden" />, true);
  }
  if (selected.isLoading || !selected.data) return statePage(<Skeleton />, true);

  const review = selected.data;
  return (
    <div className="stack">
      {pageHeader}
      {sourceTabs}
      {reviewControls}
      <div className="review-layout">
        <Card>
          <h2>{SOURCE_LABELS[activeSource]}</h2>
          <div className="stack">
            {queue.data.items.map((item) => (
              <button
                className={item.id === review.id ? "list-row active" : "list-row"}
                key={item.id}
                type="button"
                onClick={() =>
                  setSourceState((current) =>
                    updateReviewSelection(current, activeSource, item.id),
                  )
                }
              >
                <strong>{item.company.name ?? "Unbekannte Firma"}</strong>
                <span>{reviewListCaption(item)}</span>
              </button>
            ))}
          </div>
        </Card>
        <div className="stack">
          <Card>
            <h2>{review.company.name ?? "Unbekannte Firma"}</h2>
            <span className="form-message">{SOURCE_LABELS[review.data_source]}</span>
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
            <VerificationDetails verification={review.company.verification} />
            <AdvertiserProofDetails advertiserProof={review.advertiser_proof ?? []} />
            <DeferredChannels channels={review.company.deferred_channels} />
            <dl className="detail-list">
              <ReviewProvenanceRows provenance={review.provenance} />
              <div><dt>Seite</dt><dd>{review.page ?? "—"}</dd></div>
              <div><dt>Bounding-Box</dt><dd>{Array.isArray(review.bbox) ? review.bbox.join(" × ") : displayValue(review.bbox)}</dd></div>
              <div><dt>Review-Status</dt><dd>{review.restoration.review_status ?? "—"}</dd></div>
              <div><dt>Geometrie</dt><dd>{review.restoration.geometry_quality_status ?? "—"}</dd></div>
              <div><dt>Modell</dt><dd>{review.restoration.model_name ?? "—"}</dd></div>
              <div><dt>Plan-Digest</dt><dd>{review.restoration.plan_digest ?? "—"}</dd></div>
            </dl>
            <h3>Inhaltsabgleich</h3>
            {!review.restoration.content_comparison ? (
              <p className="form-message">Kein Inhaltsabgleich verfügbar.</p>
            ) : review.restoration.content_comparison.findings.length === 0 ? (
              <p className="form-message">Keine Abweichungen erkannt.</p>
            ) : (
              <div className="form-message">
                Schweregrad: {review.restoration.content_comparison.severity ?? review.restoration.content_comparison.status}
                <ul>
                {review.restoration.content_comparison.findings.map((finding, index) => (
                  <li key={`${finding.type}-${finding.category}-${index}`}>
                    {finding.severity ?? "unsicher"} · {finding.type === "missing" ? "Fehlt" : finding.type === "new" ? "Neu" : "Unsicher"} · {finding.category}: {finding.value}
                  </li>
                ))}
                </ul>
              </div>
            )}
            {review.restoration.visual_comparison?.alignment && (
              <p className="form-message">
                Ausrichtung: {review.restoration.visual_comparison.alignment.class ?? "—"} ·
                {" "}Güte: {review.restoration.visual_comparison.alignment.score?.toFixed(3) ?? "—"} ·
                {" "}verlorene Zellen: {review.restoration.visual_comparison.lost_cells ?? 0} ·
                {" "}ergänzte Zellen: {review.restoration.visual_comparison.added_cells ?? 0}
              </p>
            )}
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
