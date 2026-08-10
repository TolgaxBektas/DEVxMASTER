import { useState } from "react";
import { useModuleQuery, type ModulePageProps } from "@xmaster-center/ui";

type Source = {
  id: number;
  url: string;
  status: string;
  score: number;
  lastFetchedAt?: string | null;
  lastError?: string | null;
};

export function SourcesPage({ api }: ModulePageProps) {
  const sources = useModuleQuery<Source[]>(api, "modules.ingestion.sources.list");
  const [message, setMessage] = useState("");
  if (sources.isLoading) return <p>Lade Quellen …</p>;
  if (sources.error) return <p>Quellen konnten nicht geladen werden.</p>;
  return (
    <section>
      <h1>Quellen</h1>
      {sources.data?.length ? <ul>{sources.data.map((source) => (
        <li key={source.id}>
          <strong>{source.status}</strong> <a href={source.url}>{source.url}</a>
          {source.lastError ? <span> – {source.lastError}</span> : null}
          {source.status === "approved" ? (
            <button type="button" onClick={() => {
              void api.mutate("modules.ingestion.sources.fetch", { id: source.id })
                .then(() => setMessage("Abruf eingeplant"))
                .catch(() => setMessage("Abruf konnte nicht eingeplant werden"));
            }}>Abrufen</button>
          ) : null}
        </li>
      ))}</ul> : <p>Keine Quellen vorgeschlagen.</p>}
      {message ? <p>{message}</p> : null}
    </section>
  );
}
