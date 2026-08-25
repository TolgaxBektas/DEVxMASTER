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
type Quote = {
  id: number;
  quoteNumber: string;
  recipientName: string;
  total: string;
  currency: string;
  status: string;
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
  const quotes = useModuleQuery<Quote[]>(
    api,
    "modules.billing.quotes.list",
  );
  const [issuerName, setIssuerName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [recipient, setRecipient] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("100.00");
  const [selectedIssuer, setSelectedIssuer] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState("");
  const [selectedQuote, setSelectedQuote] = useState("");
  const [quoteIssuer, setQuoteIssuer] = useState("");
  const [quoteOccurrenceId, setQuoteOccurrenceId] = useState("");
  const [quoteRecipient, setQuoteRecipient] = useState("");
  const [quoteAddress, setQuoteAddress] = useState("");
  const [quoteEmail, setQuoteEmail] = useState("");
  const [quoteValidUntil, setQuoteValidUntil] = useState("");
  const [quoteDescription, setQuoteDescription] = useState("");
  const [quoteQuantity, setQuoteQuantity] = useState("1.00");
  const [quoteUnitPrice, setQuoteUnitPrice] = useState("100.00");
  const [quoteNotes, setQuoteNotes] = useState("");
  const [message, setMessage] = useState("");
  if ([issuers, invoices, dunning, quotes].some((query) => query.isLoading))
    return <Skeleton />;
  if ([issuers, invoices, dunning, quotes].some((query) => query.error)) {
    return <EmptyState title="Faktura-Daten konnten nicht geladen werden" />;
  }
  const runMutation = async (
    operation: () => Promise<unknown>,
    success: string,
    failure: string,
    invalidations: readonly string[],
  ) => {
    setMessage("");
    try {
      await operation();
      for (const query of invalidations) await api.invalidate?.(query);
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : failure);
    }
  };
  const createIssuer = async (event: FormEvent) => {
    event.preventDefault();
    await runMutation(
      () => api.mutate("modules.billing.issuers.create", {
        name: issuerName,
        invoicePrefix: prefix,
        currency: "EUR",
        vatTreatment: "VAT19",
      }),
      "Aussteller angelegt",
      "Aussteller konnte nicht angelegt werden",
      ["modules.billing.issuers.list"],
    );
  };
  const createInvoice = async (event: FormEvent) => {
    event.preventDefault();
    await runMutation(
      () => api.mutate("modules.billing.invoices.create", {
        issuerId: Number(selectedIssuer),
        recipientName: recipient,
        items: [{ description, quantity: "1.00", unitPrice: amount }],
      }),
      "Rechnung angelegt",
      "Rechnung konnte nicht angelegt werden",
      ["modules.billing.invoices.list"],
    );
  };
  const createQuote = async (event: FormEvent) => {
    event.preventDefault();
    const occurrenceId = quoteOccurrenceId.trim();
    const validUntil = quoteValidUntil.trim();
    await runMutation(
      () => api.mutate("modules.billing.quotes.create", {
        issuerId: Number(quoteIssuer),
        ...(occurrenceId ? { occurrenceId: Number(occurrenceId) } : {}),
        recipientName: quoteRecipient,
        ...(quoteAddress ? { recipientAddress: quoteAddress } : {}),
        ...(quoteEmail ? { recipientEmail: quoteEmail } : {}),
        ...(validUntil ? { validUntil } : {}),
        ...(quoteNotes ? { notes: quoteNotes } : {}),
        items: [{
          description: quoteDescription,
          quantity: quoteQuantity,
          unitPrice: quoteUnitPrice,
        }],
      }),
      "Angebot angelegt",
      "Angebot konnte nicht angelegt werden",
      ["modules.billing.quotes.list"],
    );
  };
  const issue = async () => {
    await runMutation(
      () => api.mutate("modules.billing.invoices.issue", {
        id: Number(selectedInvoice),
      }),
      "Rechnung ausgestellt",
      "Rechnung konnte nicht ausgestellt werden",
      ["modules.billing.invoices.list"],
    );
  };
  const pay = async () => {
    await runMutation(
      () => api.mutate("modules.billing.invoices.pay", {
        id: Number(selectedInvoice),
        amount,
      }),
      "Zahlung erfasst",
      "Zahlung konnte nicht erfasst werden",
      ["modules.billing.invoices.list"],
    );
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
    await runMutation(
      () => api.mutate("modules.billing.dunning.run"),
      "Mahnlauf ausgeführt",
      "Mahnlauf konnte nicht ausgeführt werden",
      ["modules.billing.invoices.list", "modules.billing.dunning.list"],
    );
  };
  const quoteAction = async (
    operation: "send" | "accept" | "decline",
    success: string,
  ) => {
    await runMutation(
      () => api.mutate(`modules.billing.quotes.${operation}`, { id: Number(selectedQuote) }),
      success,
      "Angebot konnte nicht geändert werden",
      ["modules.billing.quotes.list"],
    );
  };
  const downloadQuotePdf = async () => {
    await runMutation(async () => {
      const result = await api.query<{ filename: string; base64: string }>(
        "modules.billing.quotes.pdf",
        { id: Number(selectedQuote) },
      );
      const bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
    }, "PDF heruntergeladen", "PDF konnte nicht erstellt werden", []);
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
      {(path === "/billing" || path === "/billing/quotes") && (
        <Card>
          <h2>Angebot anlegen</h2>
          <form className="form-grid" onSubmit={createQuote}>
            <select
              className="ui-input"
              required
              value={quoteIssuer}
              onChange={(event) => setQuoteIssuer(event.target.value)}
            >
              <option value="">Aussteller wählen</option>
              {issuers.data?.map((issuer) => (
                <option key={issuer.id} value={issuer.id}>
                  {issuer.name}
                </option>
              ))}
            </select>
            <Input
              type="number"
              min="1"
              placeholder="Fundstelle-ID (optional)"
              value={quoteOccurrenceId}
              onChange={(event) => setQuoteOccurrenceId(event.target.value)}
            />
            <Input
              required
              placeholder="Empfänger"
              value={quoteRecipient}
              onChange={(event) => setQuoteRecipient(event.target.value)}
            />
            <Input
              placeholder="Adresse"
              value={quoteAddress}
              onChange={(event) => setQuoteAddress(event.target.value)}
            />
            <Input
              type="email"
              placeholder="E-Mail"
              value={quoteEmail}
              onChange={(event) => setQuoteEmail(event.target.value)}
            />
            <Input
              type="date"
              aria-label="Gültig bis"
              value={quoteValidUntil}
              onChange={(event) => setQuoteValidUntil(event.target.value)}
            />
            <Input
              required
              placeholder="Beschreibung"
              value={quoteDescription}
              onChange={(event) => setQuoteDescription(event.target.value)}
            />
            <Input
              required
              type="number"
              min="0.01"
              step="0.01"
              placeholder="Menge"
              value={quoteQuantity}
              onChange={(event) => setQuoteQuantity(event.target.value)}
            />
            <Input
              required
              type="number"
              min="0"
              step="0.01"
              placeholder="Einzelpreis"
              value={quoteUnitPrice}
              onChange={(event) => setQuoteUnitPrice(event.target.value)}
            />
            <textarea
              className="ui-input"
              placeholder="Anmerkung"
              value={quoteNotes}
              onChange={(event) => setQuoteNotes(event.target.value)}
            />
            <Button type="submit">Angebot anlegen</Button>
          </form>
          <h2>Angebote</h2>
          <DataTable
            rows={quotes.data ?? []}
            columns={[
              { key: "quoteNumber", label: "Nummer" },
              { key: "recipientName", label: "Empfänger" },
              { key: "total", label: "Summe" },
              { key: "currency", label: "Währung" },
              { key: "status", label: "Status" },
            ]}
          />
          <select
            className="ui-input"
            value={selectedQuote}
            onChange={(event) => setSelectedQuote(event.target.value)}
          >
            <option value="">Angebot wählen</option>
            {quotes.data?.map((quote) => (
              <option key={quote.id} value={quote.id}>
                {quote.quoteNumber} · {quote.status}
              </option>
            ))}
          </select>
          <div className="row-actions">
            <Button onClick={() => quoteAction("send", "Angebot versendet")}>
              Versenden
            </Button>
            <Button onClick={() => quoteAction("accept", "Angebot angenommen")}>
              Annehmen
            </Button>
            <Button onClick={() => quoteAction("decline", "Angebot abgelehnt")}>
              Ablehnen
            </Button>
            <Button variant="secondary" onClick={downloadQuotePdf}>
              PDF herunterladen
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function title(path: string) {
  if (path.endsWith("/issuers")) return "Aussteller";
  if (path.endsWith("/invoices")) return "Rechnungen";
  if (path.endsWith("/dunning")) return "Mahnwesen";
  if (path.endsWith("/quotes")) return "Angebote";
  return "Faktura";
}
