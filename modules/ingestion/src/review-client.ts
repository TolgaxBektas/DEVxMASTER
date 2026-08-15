export type PifReview = {
  id: number;
  reason: string;
  status: string;
  reviewed_at: string | null;
  document_id: number | null;
  ad_id: number | null;
  page: number | null;
  company: {
    id: number | null;
    name: string | null;
    extracted_values: Record<string, unknown>;
    evidence: unknown;
  };
  bbox: unknown;
  restoration: {
    review_status: string | null;
    geometry_quality_status: string | null;
    model_name: string | null;
    plan_digest: string | null;
  };
  images: {
    original_available: boolean;
    restored_available: boolean;
  };
  created_at: string | null;
};

export type PifReviewDecision = {
  id: number;
  status: string;
  note: string | null;
  next_open_id: number | null;
};

export type PifReviewClient = {
  listOpen(): Promise<PifReview[]>;
  get(id: number): Promise<PifReview>;
  decide(id: number, decision: "approve" | "reject", note?: string): Promise<PifReviewDecision>;
  image(id: number, kind: "original" | "restored"): Promise<Uint8Array>;
};

export function createPifReviewClient(input: {
  baseUrl: string;
  serviceToken: string;
}): PifReviewClient {
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(`${input.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: {
          "x-service-token": input.serviceToken,
          ...(init?.headers ?? {}),
        },
      });
    } catch {
      throw new Error("Prüfdienst ist nicht erreichbar");
    }
    if (!response.ok) {
      if (response.status === 404) throw new Error("Prüffall wurde nicht gefunden");
      throw new Error("Prüfdienst hat die Anfrage abgelehnt");
    }
    return response;
  };
  return {
    async listOpen() {
      const response = await request("/api/v1/reviews/open");
      return (await response.json()) as PifReview[];
    },
    async get(id) {
      const response = await request(`/api/v1/reviews/${id}`);
      return (await response.json()) as PifReview;
    },
    async decide(id, decision, note) {
      const response = await request(`/api/v1/reviews/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
      });
      return (await response.json()) as PifReviewDecision;
    },
    async image(id, kind) {
      const response = await request(`/api/v1/reviews/${id}/${kind}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
