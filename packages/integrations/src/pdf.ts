import PDFDocument from "pdfkit";

export type Pdf = { text(title: string, body: string): Promise<Uint8Array> };

export class PdfKitPdf implements Pdf {
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
}

export class NoopPdf implements Pdf {
  async text(title: string, body: string) {
    return new TextEncoder().encode(`PDF\n${title}\n${body}`);
  }
}
