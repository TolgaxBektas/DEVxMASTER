import PDFDocument from "pdfkit";

export type QuotePdfInput = {
  issuer: {
    name: string;
    address: string | null;
    letterhead: string | null;
    paymentTermDays: number;
    bankName: string | null;
    iban: string | null;
    bic: string | null;
  };
  quote: {
    quoteNumber: string;
    currency: string;
    subtotal: string;
    vatRate: string;
    vatAmount: string;
    total: string;
    validUntil: Date | null;
    recipientName: string;
    recipientAddress: string | null;
    recipientEmail: string | null;
    notes: string | null;
    adImageKey: string | null;
    createdAt?: Date;
  };
  items: Array<{
    position: number;
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
  }>;
  loadImage?: (key: string) => Promise<Uint8Array | null>;
};

export type Pdf = {
  text(title: string, body: string): Promise<Uint8Array>;
  quote(input: QuotePdfInput): Promise<Uint8Array>;
};

export class PdfKitPdf implements Pdf {
  constructor(
    private readonly loadImage?: (key: string) => Promise<Uint8Array | null>,
  ) {}

  async text(title: string, body: string): Promise<Uint8Array> {
    const document = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve, reject) => {
      document.on("end", () => resolve());
      document.on("error", reject);
    });
    document.fontSize(18).text(title).moveDown().fontSize(11).text(body);
    document.end();
    await done;
    return Buffer.concat(chunks);
  }

  async quote(input: QuotePdfInput): Promise<Uint8Array> {
    const document = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve, reject) => {
      document.on("end", () => resolve());
      document.on("error", reject);
    });
    document.fontSize(18).text(input.issuer.name);
    document.fontSize(9).text(input.issuer.address ?? "");
    if (input.issuer.letterhead) document.text(input.issuer.letterhead);
    document.moveDown().fontSize(16).text(`Angebot ${input.quote.quoteNumber}`);
    document.fontSize(10)
      .text(`Datum: ${(input.quote.createdAt ?? new Date()).toLocaleDateString("de-DE")}`)
      .text(`Gültig bis: ${input.quote.validUntil?.toLocaleDateString("de-DE") ?? "ohne Befristung"}`);
    document.moveDown().fontSize(11).text("Empfänger");
    document.text(input.quote.recipientName);
    if (input.quote.recipientAddress) document.text(input.quote.recipientAddress);
    if (input.quote.recipientEmail) document.text(input.quote.recipientEmail);
    document.moveDown().fontSize(10);
    document.text("Pos.   Beschreibung                              Menge   Einzelpreis   Betrag");
    document.moveTo(50, document.y).lineTo(545, document.y).stroke();
    for (const item of input.items) {
      document.text(
        `${item.position}.    ${item.description}   ${item.quantity}   ${item.unitPrice} ${input.quote.currency}   ${item.amount} ${input.quote.currency}`,
      );
    }
    document.moveDown();
    document.text(`Netto: ${input.quote.subtotal} ${input.quote.currency}`);
    document.text(`USt (${input.quote.vatRate} %): ${input.quote.vatAmount} ${input.quote.currency}`);
    document.font("Helvetica-Bold").text(`Gesamt: ${input.quote.total} ${input.quote.currency}`).font("Helvetica");
    document.moveDown().text(`Zahlungsziel: ${input.issuer.paymentTermDays} Tage`);
    if (input.issuer.bankName) document.text(`Bank: ${input.issuer.bankName}`);
    if (input.issuer.iban) document.text(`IBAN: ${input.issuer.iban}`);
    if (input.issuer.bic) document.text(`BIC: ${input.issuer.bic}`);
    if (input.quote.notes) document.moveDown().text(input.quote.notes);
    document.moveDown();
    let image: Uint8Array | null = null;
    if (input.quote.adImageKey && (input.loadImage ?? this.loadImage)) {
      try {
        image = await (input.loadImage ?? this.loadImage)!(input.quote.adImageKey);
      } catch {
        image = null;
      }
    }
    if (image) {
      document.text("Restaurierte Anzeige:");
      document.image(Buffer.from(image), 50, document.y + 8, {
        fit: [495, 180],
        align: "center",
        valign: "center",
      });
    } else {
      document.text("Anzeigenbild nicht verfügbar");
    }
    document.end();
    await done;
    return Buffer.concat(chunks);
  }
}

export class NoopPdf implements Pdf {
  async text(title: string, body: string) {
    return new TextEncoder().encode(`PDF\n${title}\n${body}`);
  }

  async quote(input: QuotePdfInput) {
    const image = input.quote.adImageKey && input.loadImage
      ? await input.loadImage(input.quote.adImageKey)
      : null;
    return new TextEncoder().encode([
      "PDF",
      `Angebot ${input.quote.quoteNumber}`,
      input.issuer.name,
      input.quote.recipientName,
      ...input.items.map((item) => `${item.position}. ${item.description} ${item.amount}`),
      `Netto: ${input.quote.subtotal} ${input.quote.currency}`,
      `USt: ${input.quote.vatAmount} ${input.quote.currency}`,
      `Gesamt: ${input.quote.total} ${input.quote.currency}`,
      image ? "Restaurierte Anzeige vorhanden" : "Anzeigenbild nicht verfügbar",
    ].join("\n"));
  }
}
