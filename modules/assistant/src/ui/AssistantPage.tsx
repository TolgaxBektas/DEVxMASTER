import {
  Button,
  Card,
  EmptyState,
  Skeleton,
  useModuleQuery,
  type ModulePageProps,
} from "@xmaster-center/ui";

type Briefing = {
  overdueInvoices?: number;
  newLeads?: number;
  deadLetters?: number;
  costsMicros?: number;
  budgetMicros?: number;
};

type Proposal = {
  id: string;
  title: string;
  state: string;
  policy: "automatic" | "suggestion" | "human_required";
};

const policyLabels: Record<Proposal["policy"], string> = {
  automatic: "Automatisch",
  suggestion: "Vorschlag",
  human_required: "Menschliche Freigabe erforderlich",
};

const stateLabels: Record<string, string> = {
  approval_required: "Freigabe ausstehend",
  approved: "Freigegeben",
  executed: "Ausgeführt",
};

function formatCosts(micros: number, budgetMicros: number) {
  return `${(micros / 1_000_000).toFixed(2)} € / ${(budgetMicros / 1_000_000).toFixed(2)} €`;
}

export function AssistantPage({ api }: ModulePageProps) {
  const briefing = useModuleQuery<Briefing>(
    api,
    "modules.assistant.briefing",
  );
  const proposals = useModuleQuery<Proposal[]>(
    api,
    "modules.assistant.proposals.list",
  );
  if (briefing.isLoading || proposals.isLoading) return <Skeleton />;
  if (briefing.error || proposals.error) {
    return <EmptyState title="ALEXIS konnte das Briefing nicht laden" />;
  }
  const refreshProposals = () =>
    api.invalidate?.("modules.assistant.proposals.list");
  const approve = async (id: string) => {
    await api.mutate("modules.assistant.proposals.approve", { id });
    await refreshProposals();
  };
  const execute = async (id: string) => {
    await api.mutate("modules.assistant.proposals.execute", { id });
    await refreshProposals();
  };
  const costs = briefing.data?.costsMicros ?? 0;
  const budget = briefing.data?.budgetMicros ?? 0;

  return (
    <div className="stack">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ALEXIS</div>
          <h1>Mandantenbriefing</h1>
          <p>Modulübergreifende Lage und freigegebene Aktionen.</p>
        </div>
      </div>
      <Card>
        <h2>Lage</h2>
        <div className="metric-grid">
          <Metric
            label="Überfällige Rechnungen"
            value={briefing.data?.overdueInvoices ?? 0}
          />
          <Metric label="Neue Leads" value={briefing.data?.newLeads ?? 0} />
          <Metric label="Dead Letters" value={briefing.data?.deadLetters ?? 0} />
          <Metric
            label="KI-Kosten / Budget"
            value={formatCosts(costs, budget)}
          />
        </div>
      </Card>
      <Card>
        <h2>Aktionsvorschläge</h2>
        {proposals.data?.map((proposal) => (
          <div className="list-row" key={proposal.id}>
            <div className="proposal-meta">
              <strong>{proposal.title}</strong>
              <span className="proposal-policy">
                Policy: {policyLabels[proposal.policy]}
              </span>
              <span className="proposal-state">
                Zustand: {stateLabels[proposal.state] ?? proposal.state}
              </span>
            </div>
            <div className="proposal-actions">
              <Button
                disabled={proposal.state !== "approval_required"}
                onClick={() => void approve(proposal.id)}
              >
                Freigeben
              </Button>
              <Button
                disabled={proposal.state !== "approved"}
                onClick={() => void execute(proposal.id)}
              >
                Ausführen
              </Button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="metric-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
