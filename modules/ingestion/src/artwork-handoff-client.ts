export type ArtworkHandoffManifest = {
  company_name: string;
  preview?: string;
  confidence?: number;
  advertiser_proof: string[];
  evidence: string[];
  provenance: {
    data_source: string;
    center_tenant_id: number;
    center_occurrence_id: number;
    document_sha256: string;
    document_filename?: string;
    source_url?: string;
    area_name?: string;
    area_ags?: string;
    area_state?: string;
    publication?: string;
    edition?: string;
    year?: number;
    issue?: number;
    page: number;
    bbox: [number, number, number, number];
  };
};

export type ArtworkHandoffResult = {
  documentId: number;
  adId: number;
  reviewStatus: string;
  deduplicated: boolean;
};

export function createArtworkHandoffClient(input: {
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
}): {
  submit(payload: {
    original: Uint8Array;
    manifest: ArtworkHandoffManifest;
  }, signal?: AbortSignal): Promise<ArtworkHandoffResult>;
} {
  const timeoutMs = input.timeoutMs ?? 30_000;
  return {
    async submit(payload, signal) {
      const form = new FormData();
      form.append(
        "original",
        new Blob([payload.original.slice().buffer as ArrayBuffer], {
          type: "image/png",
        }),
        "original.png",
      );
      form.append("manifest", JSON.stringify(payload.manifest));
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);
      if (signal?.aborted) onAbort();
      try {
        const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/imports/print-find`, {
          method: "POST",
          headers: { "x-service-token": input.serviceToken },
          body: form,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Bearbeitungsdienst hat die Übergabe abgelehnt");
        }
        const result = await response.json() as {
          document_id: number;
          ad_id: number;
          review_status: string;
          deduplicated: boolean;
        };
        return {
          documentId: result.document_id,
          adId: result.ad_id,
          reviewStatus: result.review_status,
          deduplicated: result.deduplicated,
        };
      } catch (error) {
        if (timedOut) {
          throw new Error("Bearbeitungsdienst hat nicht rechtzeitig geantwortet");
        }
        if (
          error instanceof Error &&
          error.message === "Bearbeitungsdienst hat die Übergabe abgelehnt"
        ) {
          throw error;
        }
        throw new Error("Bearbeitungsdienst ist nicht erreichbar");
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
