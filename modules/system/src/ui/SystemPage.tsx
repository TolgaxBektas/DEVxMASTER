import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Skeleton,
  useModuleQuery,
  type ModulePageProps,
} from "@xmaster-center/ui";

type Health = { id: string; status: string };
type AuditRow = {
  seq: number;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: string;
};
type JobRow = {
  id: string;
  name: string;
  status: string;
  attempts: number;
  lastError: string | null;
};

export function SystemPage({ api }: ModulePageProps) {
  const path = window.location.pathname;
  const health = useModuleQuery<Health[]>(api, "modules.system.health");
  const audit = useModuleQuery<AuditRow[]>(api, "modules.system.audit.list");
  const jobs = useModuleQuery<JobRow[]>(api, "modules.system.jobs.list");
  const costs = useModuleQuery<Record<string, unknown>[]>(
    api,
    "modules.system.ai.costs",
  );
  const flags = useModuleQuery<Record<string, unknown>[]>(
    api,
    "modules.system.flags",
  );
  const policies = useModuleQuery<Record<string, unknown>[]>(
    api,
    "modules.system.policies",
  );
  const [verification, setVerification] = useState<{
    ok: boolean;
    totalEntries: number;
  } | null>(null);
  const verify = async () =>
    setVerification(await api.query("modules.system.audit.verify"));
  if (
    [health, audit, jobs, costs, flags, policies].some(
      (query) => query.isLoading,
    )
  )
    return <Skeleton />;
  if (
    [health, audit, jobs, costs, flags, policies].some((query) => query.error)
  ) {
    return (
      <EmptyState
        title="Betriebsdaten konnten nicht geladen werden"
        description="Bitte Anmeldung und API prüfen."
      />
    );
  }
  const title =
    path === "/system/jobs"
      ? "Jobs & Warteschlange"
      : path === "/system/ai"
        ? "KI-Kosten"
        : path === "/system/flags"
          ? "Feature Flags"
          : path === "/system/policies"
            ? "Automations-Policies"
            : "Betriebsübersicht";
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SYSTEM</div>
          <h1>{title}</h1>
          <p>Transparenz für Betrieb, Audit und Automatisierung.</p>
        </div>
        {path.includes("audit") && (
          <Button onClick={verify}>Kette prüfen</Button>
        )}
      </div>
      {(path === "/system" || path === "/system/modules") && (
        <Card>
          <h2>Modulgesundheit</h2>
          <div className="health-grid">
            {health.data?.map((item) => (
              <div className="health-item" key={item.id}>
                <strong>{item.id}</strong>
                <Badge tone={item.status === "healthy" ? "success" : "danger"}>
                  {item.status}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
      {(path === "/system" || path === "/system/audit") && (
        <Card>
          <div className="card-heading">
            <h2>Audit-Log</h2>
            <Button variant="secondary" onClick={verify}>
              Kette prüfen
            </Button>
          </div>
          {verification && (
            <div className="verify-result">
              <Badge tone={verification.ok ? "success" : "danger"}>
                {verification.ok ? "Kette intakt" : "Kette beschädigt"}
              </Badge>
              <span>{verification.totalEntries} Einträge geprüft</span>
            </div>
          )}
          <DataTable
            rows={audit.data ?? []}
            columns={[
              { key: "seq", label: "Seq" },
              { key: "action", label: "Aktion" },
              { key: "entityType", label: "Entität" },
              { key: "entityId", label: "ID" },
              { key: "createdAt", label: "Zeit" },
            ]}
          />
        </Card>
      )}
      {(path === "/system" || path === "/system/jobs") && (
        <Card>
          <h2>Job-Zustand</h2>
          <DataTable
            rows={jobs.data ?? []}
            columns={[
              { key: "name", label: "Job" },
              { key: "status", label: "Status" },
              { key: "attempts", label: "Versuche" },
              { key: "lastError", label: "Fehler" },
            ]}
          />
        </Card>
      )}
      {path === "/system/ai" && (
        <Card>
          <h2>KI-Kosten</h2>
          <DataTable
            rows={costs.data ?? []}
            columns={[
              { key: "provider", label: "Provider" },
              { key: "model", label: "Modell" },
              { key: "costMicros", label: "Kosten (µ)" },
              { key: "createdAt", label: "Zeit" },
            ]}
          />
        </Card>
      )}
      {path === "/system/flags" && (
        <Card>
          <h2>Feature Flags</h2>
          <DataTable
            rows={flags.data ?? []}
            columns={[
              { key: "key", label: "Schlüssel" },
              { key: "enabled", label: "Aktiv" },
            ]}
          />
        </Card>
      )}
      {path === "/system/policies" && (
        <Card>
          <h2>Automations-Policies</h2>
          <DataTable
            rows={policies.data ?? []}
            columns={[
              { key: "operation", label: "Vorgang" },
              { key: "mode", label: "Modus" },
            ]}
          />
        </Card>
      )}
    </div>
  );
}
