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
    vatTreatment: "RC" | "VAT19" | "VAT0";
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
    const columns = {
      position: { x: 50, width: 35 },
      description: { x: 90, width: 245 },
      quantity: { x: 340, width: 55 },
      unitPrice: { x: 400, width: 75 },
      amount: { x: 480, width: 82 },
    };
    const renderTableHeader = () => {
      const y = document.y;
      document.font("Helvetica-Bold")
        .text("Pos.", columns.position.x, y, columns.position)
        .text("Beschreibung", columns.description.x, y, columns.description)
        .text("Menge", columns.quantity.x, y, {
          ...columns.quantity,
          align: "right",
        })
        .text("Einzelpreis", columns.unitPrice.x, y, {
          ...columns.unitPrice,
          align: "right",
        })
        .text("Betrag", columns.amount.x, y, {
          ...columns.amount,
          align: "right",
        })
        .font("Helvetica");
      document.moveTo(50, y + 17).lineTo(562, y + 17).stroke();
      document.y = y + 23;
    };
    renderTableHeader();
    for (const item of input.items) {
      const descriptionHeight = document.heightOfString(item.description, {
        width: columns.description.width,
      });
      const rowHeight = Math.max(18, descriptionHeight) + 4;
      if (document.y + rowHeight > document.page.height - document.page.margins.bottom) {
        document.addPage();
        renderTableHeader();
      }
      const y = document.y;
      document.text(String(item.position), columns.position.x, y, columns.position)
        .text(item.description, columns.description.x, y, {
          ...columns.description,
          height: rowHeight,
        })
        .text(item.quantity, columns.quantity.x, y, {
          ...columns.quantity,
          align: "right",
        })
        .text(`${item.unitPrice} ${input.quote.currency}`, columns.unitPrice.x, y, {
          ...columns.unitPrice,
          align: "right",
        })
        .text(`${item.amount} ${input.quote.currency}`, columns.amount.x, y, {
          ...columns.amount,
          align: "right",
        });
      document.y = y + rowHeight;
    }
    document.moveDown();
    document.text(`Netto: ${input.quote.subtotal} ${input.quote.currency}`);
    if (input.quote.vatTreatment === "RC") {
      document.text("Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)");
    } else {
      document.text(`USt (${input.quote.vatRate} %): ${input.quote.vatAmount} ${input.quote.currency}`);
    }
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
      if (document.y + 205 > document.page.height - document.page.margins.bottom) {
        document.addPage();
      }
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
    let image: Uint8Array | null = null;
    if (input.quote.adImageKey && input.loadImage) {
      try {
        image = await input.loadImage(input.quote.adImageKey);
      } catch {
        image = null;
      }
    }
    return new TextEncoder().encode([
      "PDF",
      `Angebot ${input.quote.quoteNumber}`,
      input.issuer.name,
      input.quote.recipientName,
      ...input.items.map((item) => `${item.position}. ${item.description} ${item.amount}`),
      `Netto: ${input.quote.subtotal} ${input.quote.currency}`,
      input.quote.vatTreatment === "RC"
        ? "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)"
        : `USt: ${input.quote.vatAmount} ${input.quote.currency}`,
      `Gesamt: ${input.quote.total} ${input.quote.currency}`,
      image ? "Restaurierte Anzeige vorhanden" : "Anzeigenbild nicht verfügbar",
    ].join("\n"));
  }
}
