import { describe, expect, it } from "vitest";
import { NoopMail } from "./mail.js";
import { NoopPdf } from "./pdf.js";
import { NoopStorage } from "./storage.js";
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
});
