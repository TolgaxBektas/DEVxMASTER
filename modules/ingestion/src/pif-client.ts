import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Storage } from "@xmaster-center/integrations";
import { responseErrorMessage } from "@xmaster-center/kernel";
import type { ProcessedPage } from "./module.js";

async function processPdf(input: {
  baseUrl: string;
  serviceToken: string;
  bytes: Uint8Array;
  outputPrefix: string;
}): Promise<{ status: number; body: string }> {
  const boundary = `----xmaster${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="document.pdf"\r\n` +
      "Content-Type: application/pdf\r\n\r\n",
  );
  const tail = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="output_prefix"\r\n\r\n` +
      `${input.outputPrefix}\r\n--${boundary}--\r\n`,
  );
  const body = Buffer.concat([head, Buffer.from(input.bytes), tail]);
  const target = new URL(`${input.baseUrl.replace(/\/$/, "")}/api/v1/process`);
  const requestFunction =
    target.protocol === "https:" ? httpsRequest : target.protocol === "http:" ? httpRequest : null;
  if (!requestFunction) throw new Error("Unsupported PIF URL protocol");

  return new Promise((resolve, reject) => {
    const request = requestFunction(
      {
        hostname: target.hostname,
        ...(target.port ? { port: target.port } : {}),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": body.length,
          "x-service-token": input.serviceToken,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

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
    let response: { status: number; body: string };
    try {
      response = await processPdf({
        baseUrl: input.baseUrl,
        serviceToken: input.serviceToken,
        bytes,
        outputPrefix: document.outputPrefix,
      });
    } catch {
      throw new Error("PDF-Verarbeitung ist nicht erreichbar");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(responseErrorMessage(response.body, response.status));
    }
    const result = JSON.parse(response.body) as {
      metadata?: { title?: string; subject?: string; creation_date?: string };
      pages: Array<{
        page_number: number;
        text: string;
        image_key: string | null;
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
      imageKey: page.image_key ?? null,
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
