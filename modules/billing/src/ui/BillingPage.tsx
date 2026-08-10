import { useState, type FormEvent } from "react";
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

type Issuer = {
  id: number;
  name: string;
  invoicePrefix: string;
  currency: string;
};
type Invoice = {
  id: number;
  invoiceNumber: string;
  recipientName: string;
  total: string;
  currency: string;
  status: string;
};
type Dunning = {
  id: number;
  invoiceId: number;
  level: number;
  totalDue: string;
  subject: string;
};

export function BillingPage({ api }: ModulePageProps) {
  const path = window.location.pathname;
  const issuers = useModuleQuery<Issuer[]>(api, "modules.billing.issuers.list");
  const invoices = useModuleQuery<Invoice[]>(
    api,
    "modules.billing.invoices.list",
  );
  const dunning = useModuleQuery<Dunning[]>(
    api,
    "modules.billing.dunning.list",
  );
  const [issuerName, setIssuerName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [recipient, setRecipient] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("100.00");
  const [selectedIssuer, setSelectedIssuer] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState("");
  const [message, setMessage] = useState("");
  if ([issuers, invoices, dunning].some((query) => query.isLoading))
    return <Skeleton />;
  if ([issuers, invoices, dunning].some((query) => query.error)) {
    return <EmptyState title="Faktura-Daten konnten nicht geladen werden" />;
  }
  const createIssuer = async (event: FormEvent) => {
    event.preventDefault();
    await api.mutate("modules.billing.issuers.create", {
      name: issuerName,
      invoicePrefix: prefix,
      currency: "EUR",
      vatTreatment: "VAT19",
    });
    setMessage("Aussteller angelegt");
    await api.invalidate?.("modules.billing.issuers.list");
  };
  const createInvoice = async (event: FormEvent) => {
    event.preventDefault();
    await api.mutate("modules.billing.invoices.create", {
      issuerId: Number(selectedIssuer),
      recipientName: recipient,
      items: [{ description, quantity: "1.00", unitPrice: amount }],
    });
    setMessage("Rechnung angelegt");
    await api.invalidate?.("modules.billing.invoices.list");
  };
  const issue = async () => {
    await api.mutate("modules.billing.invoices.issue", {
      id: Number(selectedInvoice),
    });
    setMessage("Rechnung ausgestellt");
    await api.invalidate?.("modules.billing.invoices.list");
  };
  const pay = async () => {
    await api.mutate("modules.billing.invoices.pay", {
      id: Number(selectedInvoice),
      amount,
    });
    setMessage("Zahlung erfasst");
    await api.invalidate?.("modules.billing.invoices.list");
  };
  const downloadPdf = async () => {
    const result = await api.query<{ filename: string; base64: string }>(
      "modules.billing.invoices.pdf",
      { id: Number(selectedInvoice) },
    );
    const bytes = Uint8Array.from(atob(result.base64), (char) =>
      char.charCodeAt(0),
    );
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/pdf" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = result.filename;
    link.click();
    URL.revokeObjectURL(url);
    setMessage("PDF heruntergeladen");
  };
  const runDunning = async () => {
    await api.mutate("modules.billing.dunning.run");
    setMessage("Mahnlauf ausgeführt");
    await api.invalidate?.("modules.billing.invoices.list");
    await api.invalidate?.("modules.billing.dunning.list");
  };
  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">FAKTURA</div>
          <h1>{title(path)}</h1>
          <p>Kaufmännische Vorgänge mit nachvollziehbarer Belegkette.</p>
        </div>
      </div>
      {message && (
        <Card>
          <strong>{message}</strong>
        </Card>
      )}
      {(path === "/billing" || path === "/billing/issuers") && (
        <Card>
          <h2>Aussteller</h2>
          <form className="form-grid" onSubmit={createIssuer}>
            <Input
              required
              placeholder="Name"
              value={issuerName}
              onChange={(event) => setIssuerName(event.target.value)}
            />
            <Input
              required
              placeholder="Präfix"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
            />
            <Button type="submit">Aussteller anlegen</Button>
          </form>
          <DataTable
            rows={issuers.data ?? []}
            columns={[
              { key: "name", label: "Name" },
              { key: "invoicePrefix", label: "Präfix" },
              { key: "currency", label: "Währung" },
            ]}
          />
        </Card>
      )}
      {(path === "/billing" || path === "/billing/invoices") && (
        <Card>
          <h2>Rechnung anlegen</h2>
          <form className="form-grid" onSubmit={createInvoice}>
            <select
              className="ui-input"
              required
              value={selectedIssuer}
              onChange={(event) => setSelectedIssuer(event.target.value)}
            >
              <option value="">Aussteller wählen</option>
              {issuers.data?.map((issuer) => (
                <option key={issuer.id} value={issuer.id}>
                  {issuer.name}
                </option>
              ))}
            </select>
            <Input
              required
              placeholder="Empfänger"
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
            />
            <Input
              required
              placeholder="Position"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <Input
              required
              placeholder="Betrag"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Button type="submit">Rechnung anlegen</Button>
          </form>
          <DataTable
            rows={invoices.data ?? []}
            columns={[
              { key: "invoiceNumber", label: "Nummer" },
              { key: "recipientName", label: "Empfänger" },
              { key: "total", label: "Betrag" },
              { key: "currency", label: "Währung" },
              { key: "status", label: "Status" },
            ]}
          />
        </Card>
      )}
      {(path === "/billing" || path === "/billing/invoices") && (
        <Card>
          <h2>Rechnung bearbeiten</h2>
          <select
            className="ui-input"
            value={selectedInvoice}
            onChange={(event) => setSelectedInvoice(event.target.value)}
          >
            <option value="">Rechnung wählen</option>
            {invoices.data?.map((invoice) => (
              <option key={invoice.id} value={invoice.id}>
                {invoice.invoiceNumber} · {invoice.status}
              </option>
            ))}
          </select>
          <div className="row-actions">
            <Button onClick={issue}>Ausstellen</Button>
            <Button variant="secondary" onClick={downloadPdf}>
              PDF herunterladen
            </Button>
            <Button variant="secondary" onClick={pay}>
              Zahlung erfassen
            </Button>
          </div>
        </Card>
      )}
      {(path === "/billing" || path === "/billing/dunning") && (
        <Card>
          <div className="card-heading">
            <h2>Mahnprotokoll</h2>
            <Button onClick={runDunning}>Mahnlauf auslösen</Button>
          </div>
          <DataTable
            rows={dunning.data ?? []}
            columns={[
              { key: "invoiceId", label: "Rechnung" },
              { key: "level", label: "Stufe" },
              { key: "totalDue", label: "Forderung" },
              { key: "subject", label: "Betreff" },
            ]}
          />
        </Card>
      )}
    </div>
  );
}

function title(path: string) {
  if (path.endsWith("/issuers")) return "Aussteller";
  if (path.endsWith("/invoices")) return "Rechnungen";
  if (path.endsWith("/dunning")) return "Mahnwesen";
  return "Faktura";
}
