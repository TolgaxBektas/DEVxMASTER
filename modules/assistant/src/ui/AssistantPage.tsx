import { Button, Card, EmptyState, Skeleton, useModuleQuery, type ModulePageProps } from "@xmaster-center/ui";
type Briefing = { overdueInvoices?: number; newLeads?: number; deadLetters?: number; costsMicros?: number };
export function AssistantPage({ api }: ModulePageProps) {
  const briefing = useModuleQuery<Briefing>(api, "modules.assistant.briefing");
  const proposals = useModuleQuery<Array<{ id: string; title: string; state: string }>>(api, "modules.assistant.proposals.list");
  if (briefing.isLoading || proposals.isLoading) return <Skeleton />;
  if (briefing.error || proposals.error) return <EmptyState title="ALEXIS konnte das Briefing nicht laden" />;
  const approve = async (id: string) => { await api.mutate("modules.assistant.proposals.approve", { id }); await api.mutate("modules.assistant.proposals.execute", { id }); window.location.reload(); };
  return <div className="stack">
    <div className="page-heading"><div><div className="eyebrow">ALEXIS</div><h1>Mandantenbriefing</h1><p>Modulübergreifende Lage und freigegebene Aktionen.</p></div></div>
    <Card><h2>Lage</h2><div className="metric-grid"><div><strong>{briefing.data?.overdueInvoices ?? 0}</strong><span>Überfällige Rechnungen</span></div><div><strong>{briefing.data?.newLeads ?? 0}</strong><span>Neue Leads</span></div><div><strong>{briefing.data?.deadLetters ?? 0}</strong><span>Dead Letters</span></div></div></Card>
    <Card><h2>Aktionsvorschläge</h2>{proposals.data?.map((proposal) => <div className="list-row" key={proposal.id}><span>{proposal.title}</span><Button onClick={() => approve(proposal.id)}>Freigeben & ausführen</Button></div>)}</Card>
  </div>;
}
