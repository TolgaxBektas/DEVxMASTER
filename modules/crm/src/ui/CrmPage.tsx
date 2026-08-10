import { useState } from "react";
import type { FormEvent } from "react";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  Skeleton,
  useModuleQuery,
  type ModulePageProps,
} from "@xmaster-center/ui";

type Customer = {
  id: number;
  name: string;
  company: string | null;
  email: string | null;
  status: string;
};
type RecordRow = Record<string, unknown>;

export function CrmPage({ api, navigate }: ModulePageProps) {
  const path = window.location.pathname;
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [editing, setEditing] = useState<Customer | null>(null);
  const [message, setMessage] = useState("");
  const customers = useModuleQuery<Customer[]>(
    api,
    "modules.crm.customers.list",
  );
  const addresses = useModuleQuery<RecordRow[]>(
    api,
    "modules.crm.addresses.list",
  );
  const industries = useModuleQuery<RecordRow[]>(
    api,
    "modules.crm.industries.list",
  );
  const projects = useModuleQuery<RecordRow[]>(
    api,
    "modules.crm.projects.list",
  );
  const detailId = path.match(/^\/kunden\/(\d+)$/)?.[1];
  const detail = useModuleQuery<Customer>(
    api,
    "modules.crm.customers.get",
    detailId ? { id: Number(detailId) } : undefined,
  );
  if (
    [
      customers,
      addresses,
      industries,
      projects,
      ...(detailId ? [detail] : []),
    ].some((query) => query.isLoading)
  )
    return <Skeleton />;
  if (
    [
      customers,
      addresses,
      industries,
      projects,
      ...(detailId ? [detail] : []),
    ].some((query) => query.error)
  )
    return <EmptyState title="CRM-Daten konnten nicht geladen werden" />;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (editing)
        await api.mutate("modules.crm.customers.update", {
          id: editing.id,
          data: { name, company, email },
        });
      else
        await api.mutate("modules.crm.customers.create", {
          name,
          company,
          email,
        });
      setName("");
      setCompany("");
      setEmail("");
      setEditing(null);
      setMessage("Gespeichert");
      window.location.reload();
    } catch {
      setMessage("Speichern fehlgeschlagen");
    }
  };
  const remove = async (id: number) => {
    if (!window.confirm("Kunden wirklich löschen?")) return;
    await api.mutate("modules.crm.customers.delete", { id });
    window.location.reload();
  };
  if (detailId)
    return (
      <div className="stack">
        <Button variant="ghost" onClick={() => navigate("/kunden")}>
          ← Zurück
        </Button>
        <Card>
          <div className="eyebrow">KUNDE</div>
          <h1>{detail.data?.name}</h1>
          <p>
            {detail.data?.company || "Keine Firma hinterlegt"} ·{" "}
            {detail.data?.email || "Keine E-Mail hinterlegt"}
          </p>
        </Card>
      </div>
    );
  if (path === "/adressen")
    return (
      <ResourceTable
        title="Adressen"
        rows={addresses.data ?? []}
        columns={["company", "city", "email", "status"]}
      />
    );
  if (path === "/branchen")
    return (
      <ResourceTable
        title="Branchen"
        rows={industries.data ?? []}
        columns={["name", "description", "createdAt"]}
      />
    );
  if (path === "/projekte")
    return (
      <ResourceTable
        title="Projekte"
        rows={projects.data ?? []}
        columns={["name", "status", "customerId", "createdAt"]}
      />
    );
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CRM</div>
          <h1>Kunden</h1>
          <p>Mandantenbezogene Kundenkontakte zentral verwalten.</p>
        </div>
      </div>
      <Card>
        <form className="form-grid" onSubmit={submit}>
          <Input
            required
            placeholder="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            placeholder="Firma"
            value={company}
            onChange={(event) => setCompany(event.target.value)}
          />
          <Input
            type="email"
            placeholder="E-Mail"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button type="submit">
            {editing ? "Änderung speichern" : "Kunde anlegen"}
          </Button>
          {message && <span className="form-message">{message}</span>}
        </form>
      </Card>
      <Card>
        <DataTable
          rows={customers.data ?? []}
          columns={[
            {
              key: "name",
              label: "Name",
              render: (row) => (
                <button
                  className="link-button"
                  onClick={() => navigate(`/kunden/${row.id}`)}
                >
                  {row.name}
                </button>
              ),
            },
            { key: "company", label: "Firma" },
            { key: "email", label: "E-Mail" },
            { key: "status", label: "Status" },
            {
              key: "actions",
              label: "Aktionen",
              render: (row) => (
                <span className="row-actions">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditing(row);
                      setName(row.name);
                      setCompany(row.company ?? "");
                      setEmail(row.email ?? "");
                    }}
                  >
                    Bearbeiten
                  </Button>
                  <Button variant="danger" onClick={() => remove(row.id)}>
                    Löschen
                  </Button>
                </span>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

function ResourceTable({
  title,
  rows,
  columns,
}: {
  title: string;
  rows: RecordRow[];
  columns: string[];
}) {
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CRM</div>
          <h1>{title}</h1>
        </div>
      </div>
      <Card>
        <DataTable
          rows={rows}
          columns={columns.map((key) => ({ key, label: key }))}
        />
      </Card>
    </div>
  );
}
