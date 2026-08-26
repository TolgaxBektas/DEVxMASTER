import { useMemo, useState } from "react";
import { Button, Card, EmptyState, Skeleton, useModuleQuery, type ModulePageProps } from "@xmaster-center/ui";

type Area = {
  id: number; level: "state" | "district"; name: string; stateName: string;
  status: string; lastRunAt: string | null; nextDueAt: string | null; foundSources: number;
};
const date = (value: string | null) => value ? new Date(value).toLocaleDateString("de-DE") : "—";
export function AreasPage({ api }: ModulePageProps) {
  const [filter, setFilter] = useState("all");
  const [message, setMessage] = useState("");
  const areas = useModuleQuery<Area[]>(api, "modules.ingestion.areas.list");
  const capabilities = useModuleQuery<{ read: boolean; run: boolean }>(api, "modules.ingestion.areas.capabilities");
  const rows = useMemo(() => (areas.data ?? []).filter((area) => {
    if (filter === "due") return area.status === "pending" || (area.nextDueAt !== null && new Date(area.nextDueAt) <= new Date());
    return filter === "all" || area.status === filter;
  }), [areas.data, filter]);
  if (areas.isLoading || capabilities.isLoading) return <Skeleton />;
  if (areas.error || capabilities.error) return <EmptyState title="Gebiete konnten nicht geladen werden" />;
  const districts = areas.data?.filter((area) => area.level === "district") ?? [];
  const done = districts.filter((area) => area.status === "done").length;
  const run = async () => {
    try {
      await api.mutate("modules.ingestion.areas.run", { limit: 3 });
      await api.invalidate?.("modules.ingestion.areas.list");
      setMessage("Gebietslauf eingeplant.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Gebietslauf fehlgeschlagen"); }
  };
  return <div className="stack">
    <div className="page-heading"><div><div className="eyebrow">INGESTION</div><h1>Gebiete</h1><p>{done} von {districts.length} Gebieten abgearbeitet</p></div></div>
    {message && <div className="form-message">{message}</div>}
    <Card><label>Filter <select value={filter} onChange={(event) => setFilter(event.target.value)}>
      <option value="all">Alle</option><option value="pending">Offen</option><option value="running">In Arbeit</option><option value="done">Erledigt</option><option value="due">Fällig</option>
    </select></label>{capabilities.data?.run && <Button onClick={() => void run()}>Fällige Gebiete suchen</Button>}</Card>
    <Card><div className="table-wrap"><table><thead><tr><th>Bundesland</th><th>Gebiet</th><th>Stand</th><th>Letzter Lauf</th><th>Nächste Fälligkeit</th><th>Funde</th></tr></thead>
      <tbody>{rows.map((area) => <tr key={area.id}><td>{area.stateName}</td><td>{area.name}</td><td>{area.status === "done" ? "Erledigt" : area.status === "running" ? "In Arbeit" : "Offen"}</td><td>{date(area.lastRunAt)}</td><td>{date(area.nextDueAt)}</td><td>{area.foundSources}</td></tr>)}</tbody>
    </table></div></Card>
  </div>;
}
