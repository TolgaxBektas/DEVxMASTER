import { useState } from "react";
import {
  Button,
  Card,
  EmptyState,
  Skeleton,
  useModuleQuery,
  type ModulePageProps,
} from "@xmaster-center/ui";

type Source = {
  id: number;
  url: string;
  status: string;
  score: number;
  metadata?: Record<string, unknown> | null;
  lastFetchedAt?: string | null;
  lastError?: string | null;
  lastCheckedAt?: string | null;
  nextCheckAt?: string | null;
  actualityHint?: "current" | "outdated" | "unverified" | null;
};
type Capabilities = { search: boolean; approve: boolean; fetch: boolean };
const statusLabels: Record<string, string> = {
  proposed: "Vorgeschlagen",
  approved: "Freigegeben",
  rejected: "Abgelehnt",
  dead: "Nicht erreichbar",
};
const formatDate = (value?: string | null) =>
  value ? new Date(value).toLocaleString("de-DE") : "—";

export function SourcesPage({ api }: ModulePageProps) {
  const [terms, setTerms] = useState(
    "Seniorenwegweiser Stadtmagazin Bürgerbroschüre",
  );
  const [seedPages, setSeedPages] = useState("");
  const [message, setMessage] = useState("");
  const sources = useModuleQuery<Source[]>(
    api,
    "modules.ingestion.sources.list",
  );
  const capabilities = useModuleQuery<Capabilities>(
    api,
    "modules.ingestion.sources.capabilities",
  );
  if (sources.isLoading || capabilities.isLoading) return <Skeleton />;
  if (sources.error || capabilities.error) {
    return <EmptyState title="Quellen konnten nicht geladen werden" />;
  }
  const refresh = () => api.invalidate?.("modules.ingestion.sources.list");
  const search = async () => {
    setMessage("");
    try {
      await api.mutate("modules.ingestion.sources.search", {
        searchTerms: terms.split(/\s+/).filter(Boolean),
        seedPages: seedPages.split(/\s+/).filter(Boolean),
        maxResults: 50,
      });
      await refresh();
      setMessage("Suche abgeschlossen; neue Vorschläge wurden übernommen.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Suche fehlgeschlagen");
    }
  };
  const decide = async (id: number, action: "approve" | "reject") => {
    setMessage("");
    try {
      await api.mutate(`modules.ingestion.sources.${action}`, { id });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Aktion fehlgeschlagen");
    }
  };
  const fetchSource = async (id: number) => {
    setMessage("");
    try {
      await api.mutate("modules.ingestion.sources.fetch", { id });
      await refresh();
      setMessage("Abruf eingeplant.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Abruf fehlgeschlagen");
    }
  };
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">INGESTION</div>
          <h1>Quellen</h1>
          <p>
            Deutschlandweite Vorschläge für frei zugängliche deutschsprachige
            Publikationen mit Anzeigenteil.
          </p>
        </div>
      </div>
      {message && <div className="form-message">{message}</div>}
      {capabilities.data?.search && (
        <Card>
          <h2>Neue Suche</h2>
          <label>
            Suchbegriffe
            <input
              value={terms}
              onChange={(event) => setTerms(event.target.value)}
            />
          </label>
          <label>
            Optionale Startseiten
            <input
              value={seedPages}
              onChange={(event) => setSeedPages(event.target.value)}
              placeholder="https://..."
            />
          </label>
          <Button onClick={() => void search()}>Suche starten</Button>
        </Card>
      )}
      <Card>
        <h2>Vorschläge und Quellen</h2>
        {!sources.data?.length && <p>Keine Quellen vorgeschlagen.</p>}
        {sources.data?.map((source) => {
          const metadata = source.metadata ?? {};
          return (
            <div className="list-row" key={source.id}>
              <div className="proposal-meta">
                <strong>{statusLabels[source.status] ?? "Unbekannter Zustand"}</strong>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.url}
                </a>
                <span>Bewertung: {Math.round(source.score)} / 100</span>
                <span>
                  Herkunft:{" "}
                  {String(
                    metadata.found_on ??
                      metadata.found_in_sitemap ??
                      "Suchtreffer/Startseite",
                  )}
                </span>
                <span>Fundweg: {String(metadata.discovery ?? "unbekannt")}</span>
                {source.actualityHint && <span>Jahreshinweis: {{
                  current: "wahrscheinlich aktuell",
                  outdated: "wahrscheinlich veraltet",
                  unverified: "nicht belegt",
                }[source.actualityHint]}</span>}
                <span>
                  Begründung:{" "}
                  {String(metadata.reason ?? "Keine Begründung hinterlegt")}
                </span>
                <span>Zuletzt abgerufen: {formatDate(source.lastFetchedAt)}</span>
                <span>Letzte Prüfung: {formatDate(source.lastCheckedAt)}</span>
                <span>Nächste Prüfung: {formatDate(source.nextCheckAt)}</span>
                {source.lastError && <span>Letzter Fehler: {source.lastError}</span>}
              </div>
              <div className="proposal-actions">
                {capabilities.data?.approve && source.status === "proposed" && (
                  <>
                    <Button onClick={() => void decide(source.id, "approve")}>
                      Freigeben
                    </Button>
                    <Button onClick={() => void decide(source.id, "reject")}>
                      Ablehnen
                    </Button>
                  </>
                )}
                {capabilities.data?.fetch && source.status === "approved" && (
                  <Button onClick={() => void fetchSource(source.id)}>
                    Abruf starten
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}
