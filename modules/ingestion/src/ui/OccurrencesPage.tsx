import {
  Card,
  DataTable,
  EmptyState,
  Skeleton,
  useModuleQuery,
  type ModulePageProps,
} from "@xmaster-center/ui";

type Occurrence = {
  id: number;
  company?: string;
  preview?: string;
  status?: string;
};

export function OccurrencesPage({ api }: ModulePageProps) {
  const occurrences = useModuleQuery<Occurrence[]>(
    api,
    "modules.ingestion.occurrences.list",
  );
  if (occurrences.isLoading) return <Skeleton />;
  if (occurrences.error) {
    return <EmptyState title="Fundstellen konnten nicht geladen werden" />;
  }
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">INGESTION</div>
          <h1>Erkannte Fundstellen</h1>
          <p>Werbung und Kontaktdaten aus verarbeiteten Dokumenten.</p>
        </div>
      </div>
      <Card>
        <h2>Fundstellen</h2>
        <DataTable
          rows={occurrences.data ?? []}
          columns={[
            { key: "company", label: "Firma" },
            { key: "preview", label: "Vorschau" },
            { key: "status", label: "Status" },
          ]}
        />
      </Card>
    </div>
  );
}
