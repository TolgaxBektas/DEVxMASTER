import type { Storage } from "@xmaster-center/integrations";
import type { ProcessedPage } from "./module.js";

export function createPifProcessor(input: {
  storage: Storage;
  baseUrl: string;
  serviceToken: string;
}) {
  return async (document: {
    storageKey: string;
    outputPrefix: string;
  }): Promise<ProcessedPage[]> => {
    const bytes = await input.storage.get(document.storageKey);
    if (!bytes) throw new Error("Originaldatei konnte nicht geladen werden");
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }),
      "document.pdf",
    );
    form.append("output_prefix", document.outputPrefix);
    let response: Response;
    try {
      response = await fetch(`${input.baseUrl}/api/v1/process`, {
        method: "POST",
        headers: { "x-service-token": input.serviceToken },
        body: form,
      });
    } catch {
      throw new Error("PDF-Verarbeitung ist nicht erreichbar");
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body || "PDF-Verarbeitung wurde abgelehnt");
    }
    const result = (await response.json()) as {
      pages: Array<{
        page_number: number;
        text: string;
        image_key: string;
        classification: string;
        ad_probability: number;
        occurrences: Array<{
          bbox: Record<string, number>;
          image_key: string;
          confidence: number;
          company: string;
          preview: string;
        }>;
      }>;
    };
    return result.pages.map((page) => ({
      pageNumber: page.page_number,
      text: page.text,
      imageKey: page.image_key,
      classification: page.classification,
      adProbability: page.ad_probability,
      occurrences: page.occurrences.map((occurrence) => ({
        bbox: occurrence.bbox,
        imageKey: occurrence.image_key,
        confidence: occurrence.confidence,
        company: occurrence.company,
        preview: occurrence.preview,
      })),
    }));
  };
}
