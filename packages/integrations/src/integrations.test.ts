import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { NoopMail } from "./mail.js";
import { NoopPdf, PdfKitPdf } from "./pdf.js";
import { NoopStorage } from "./storage.js";
import { NoSuchKey } from "@aws-sdk/client-s3";
import { S3Storage } from "./storage.js";
import { NoopTelegram } from "./telegram.js";

describe("Integrations-Fakes", () => {
  it("arbeiten ohne Netzwerk und Zugangsdaten", async () => {
    const storage = new NoopStorage();
    await storage.put("a.txt", "hello");
    expect(new TextDecoder().decode((await storage.get("a.txt"))!)).toBe(
      "hello",
    );
    const mail = new NoopMail();
    await mail.send({ to: "test@example.invalid", subject: "Test" });
    expect(mail.sent).toHaveLength(1);
    expect((await new NoopPdf().text("Titel", "Text")).length).toBeGreaterThan(
      0,
    );
    const telegram = new NoopTelegram();
    await telegram.sendText("1", "Hallo");
    expect(telegram.messages).toHaveLength(1);
  });

  it("liefert bei einem fehlenden S3-Objekt null statt den SDK-Fehler weiterzugeben", async () => {
    const client = {
      send: async () => {
        throw new NoSuchKey({ $metadata: { httpStatusCode: 404 }, message: "missing" });
      },
    };
    const storage = new S3Storage(client as never, "xmaster-center");
    await expect(storage.get("missing.png")).resolves.toBeNull();
  });

  it("erzeugt ein Angebot mit Bild und einen Hinweis ohne Bild", async () => {
    const input = {
      issuer: {
        name: "Quantia GmbH",
        address: "Musterstraße 1, 94032 Passau",
        letterhead: "Werbeanzeigen",
        paymentTermDays: 14,
        bankName: "Beispielbank",
        iban: "DE02120300000000202051",
        bic: "BYLADEM1001",
      },
      quote: {
        quoteNumber: "AG-QNT-2026-0001",
        currency: "EUR",
        subtotal: "100.00",
        vatRate: "19.00",
        vatAmount: "19.00",
        total: "119.00",
        validUntil: new Date("2026-12-31"),
        recipientName: "Musterkunde",
        recipientAddress: "Kundenweg 2",
        recipientEmail: "kunde@example.invalid",
        notes: null,
        adImageKey: "anzeigen/muster.png",
        createdAt: new Date("2026-01-01"),
      },
      items: [{
        position: 1,
        description: "Anzeige",
        quantity: "1.00",
        unitPrice: "100.00",
        amount: "100.00",
      }],
    };
    const image = Uint8Array.from(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    const withImage = await new PdfKitPdf(async () => image).quote(input);
    const withImagePdf = Buffer.from(withImage);
    expect(withImagePdf.toString("latin1")).toContain("/Subtype /Image");
    const withoutImage = await new PdfKitPdf(async () => null).quote(input);
    const withoutImagePdf = Buffer.from(withoutImage);
    const streamStart = withoutImagePdf.indexOf(Buffer.from("stream\n")) + 7;
    const streamEnd = withoutImagePdf.indexOf(
      Buffer.from("\nendstream"),
      streamStart,
    );
    const pageText = inflateSync(
      withoutImagePdf.subarray(streamStart, streamEnd),
    ).toString("latin1");
    const decodedText = [...pageText.matchAll(/<([0-9a-f]+)>/g)]
      .map((match) => Buffer.from(match[1]!, "hex").toString("latin1"))
      .join("");
    expect(decodedText).toContain("Anzeigenbild nicht verfügbar");
    expect(new TextDecoder().decode(await new NoopPdf().quote({
      ...input,
      quote: { ...input.quote, adImageKey: null },
    }))).toContain(
      "Anzeigenbild nicht verfügbar",
    );
  });
});
