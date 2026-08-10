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
type EventRow = {
  eventId: string;
  name: string;
  deadLetter: boolean;
  deliveryAttempts: number;
  lastError: string | null;
};

export function SystemPage({ api }: ModulePageProps) {
  const path = window.location.pathname;
  const health = useModuleQuery<Health[]>(api, "modules.system.health");
  const audit = useModuleQuery<AuditRow[]>(api, "modules.system.audit.list");
  const jobs = useModuleQuery<JobRow[]>(api, "modules.system.jobs.list");
  const permissions = useModuleQuery<string[]>(
    api,
    "modules.system.permissions",
  );
  const events = useModuleQuery<EventRow[]>(
    api,
    "modules.system.events.list",
    undefined,
    permissions.data?.includes("system.events.read") ?? false,
  );
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
  const [message, setMessage] = useState("");
  const verify = async () =>
    setVerification(await api.query("modules.system.audit.verify"));
  if (
    [health, audit, jobs, permissions, costs, flags, policies].some(
      (query) => query.isLoading,
    )
  )
    return <Skeleton />;
  if (
    [health, audit, jobs, permissions, costs, flags, policies].some(
      (query) => query.error,
    )
  ) {
    return (
      <EmptyState
        title="Betriebsdaten konnten nicht geladen werden"
        description="Bitte Anmeldung und API prüfen."
      />
    );
  }
  const titles: Record<string, string> = {
    "/system": "Betriebsübersicht",
    "/system/modules": "Modulübersicht",
    "/system/audit": "Audit-Log",
    "/system/jobs": "Jobs & Warteschlange",
    "/system/ai": "KI-Kosten",
    "/system/flags": "Feature Flags",
    "/system/policies": "Automations-Policies",
  };
  const title = titles[path] ?? "Betriebsübersicht";
  const canRequeueJobs = permissions.data?.includes("system.jobs.requeue");
  const canRequeueEvents = permissions.data?.includes("system.events.requeue");
  const requeueJob = async (id: string) => {
    setMessage("");
    try {
      await api.mutate("modules.system.jobs.requeue", { id });
      await api.invalidate?.("modules.system.jobs.list");
      setMessage("Job erneut eingereiht");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Job konnte nicht erneut eingereiht werden");
    }
  };
  const requeueEvent = async (id: string) => {
    setMessage("");
    try {
      await api.mutate("modules.system.events.requeue", { id });
      await api.invalidate?.("modules.system.events.list");
      setMessage("Ereignis erneut zugestellt");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ereignis konnte nicht erneut zugestellt werden");
    }
  };
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SYSTEM</div>
          <h1>{title}</h1>
          <p>Transparenz für Betrieb, Audit und Automatisierung.</p>
        </div>
      </div>
      {message && <div className="form-message">{message}</div>}
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
            {path === "/system/audit" && (
              <Button variant="secondary" onClick={verify}>
                Kette prüfen
              </Button>
            )}
          </div>
          {path === "/system/audit" && verification && (
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
              {
                key: "action",
                label: "Aktion",
                render: (row) =>
                  row.status === "dead" && canRequeueJobs ? (
                    <Button
                      variant="secondary"
                      onClick={() => void requeueJob(row.id)}
                    >
                      Erneut einreihen
                    </Button>
                  ) : null,
              },
            ]}
          />
          <h2>Dead Letters</h2>
          <DataTable
            rows={(events.data ?? []).filter((event) => event.deadLetter)}
            columns={[
              { key: "name", label: "Ereignis" },
              { key: "eventId", label: "ID" },
              { key: "deliveryAttempts", label: "Versuche" },
              { key: "lastError", label: "Fehler" },
              {
                key: "action",
                label: "Aktion",
                render: (row) =>
                  canRequeueEvents ? (
                    <Button
                      variant="secondary"
                      onClick={() => void requeueEvent(row.eventId)}
                    >
                      Erneut zustellen
                    </Button>
                  ) : null,
              },
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
