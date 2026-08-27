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
      try {
        const parsed = JSON.parse(body) as { detail?: unknown };
        if (typeof parsed.detail === "string" && parsed.detail) {
          throw new Error(parsed.detail);
        }
      } catch (error) {
        if (error instanceof Error && error.message !== body) throw error;
      }
      throw new Error(body || "PDF-Verarbeitung wurde abgelehnt");
    }
    const result = (await response.json()) as {
      metadata?: { title?: string; subject?: string; creation_date?: string };
      pages: Array<{
        page_number: number;
        text: string;
        image_key: string;
        classification: string;
        ad_probability: number;
        occurrences: Array<{
          bbox: {
            x: number;
            y: number;
            width: number;
            height: number;
            confidence: number;
          };
          image_key: string;
          confidence: number;
          evidence?: string[];
          company: string;
          preview: string;
          contacts?: {
            phone?: string | null;
            email?: string | null;
            website?: string | null;
            postal_code?: string | null;
            city?: string | null;
          };
        }>;
        title_candidates?: Array<{ text: string; size: number }>;
      }>;
    };
    const pages = result.pages.map((page) => ({
      pageNumber: page.page_number,
      text: page.text,
      imageKey: page.image_key,
      classification: page.classification,
      adProbability: page.ad_probability,
      titleCandidates: page.title_candidates ?? [],
      occurrences: page.occurrences.map((occurrence) => ({
        bbox: occurrence.bbox,
        imageKey: occurrence.image_key,
        confidence: occurrence.confidence,
        evidence: occurrence.evidence ?? [],
        company: occurrence.company,
        preview: occurrence.preview,
        contacts: {
          phone: occurrence.contacts?.phone ?? null,
          email: occurrence.contacts?.email ?? null,
          website: occurrence.contacts?.website ?? null,
          postalCode: occurrence.contacts?.postal_code ?? null,
          city: occurrence.contacts?.city ?? null,
        },
      })),
    }));
    Object.defineProperty(pages, "pdfMetadata", {
      value: result.metadata
        ? {
            title: result.metadata.title,
            subject: result.metadata.subject,
            creationDate: result.metadata.creation_date,
          }
        : undefined,
      enumerable: false,
    });
    return pages;
  };
}
