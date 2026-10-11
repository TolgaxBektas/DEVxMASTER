export type DiscoveryProposalResponse = {
  proposals?: Array<Record<string, unknown>>;
  search_hits?: Array<{ term: string; hits: number; pdfs: number; error?: string | null }>;
  domain_evidence?: Array<{
    host: string;
    status?: string;
    entry_count?: number;
    attempts?: number;
    error?: string | null;
  }>;
};

export function mapDiscoveryProposalResponse(body: DiscoveryProposalResponse) {
  return {
    proposals: (body.proposals ?? []).map((item) => ({
      url: String(item.url),
      score: Number(item.score ?? 0),
      metadata: item,
    })),
    ...(body.search_hits ? { searchHits: body.search_hits.map((hit) => ({ ...hit })) } : {}),
    ...(body.domain_evidence ? { domainEvidence: body.domain_evidence } : {}),
  };
}
