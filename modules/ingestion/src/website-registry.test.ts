import { describe, expect, it } from "vitest";
import { isRegisteredMunicipalUrl, websiteRegister } from "./website-registry.js";

describe("Kommunalregister", () => {
  it("erkennt Registerhosts, Subdomains und grenzt fremde Hosts ab", () => {
    const website = websiteRegister().websites.find((item) => item.level === "kreis");
    if (!website) throw new Error("Keine Kreiswebsite im Register");
    const host = new URL(website.url).hostname.replace(/^www\./, "");

    expect(isRegisteredMunicipalUrl(new URL("/broschuere.pdf", website.url).toString())).toBe(true);
    expect(isRegisteredMunicipalUrl(`https://www.${host}/broschuere.pdf`)).toBe(true);
    expect(isRegisteredMunicipalUrl(`https://tourismus.${host}/heft.pdf`)).toBe(true);
    expect(isRegisteredMunicipalUrl("https://fremd.invalid/x.pdf")).toBe(false);
    expect(isRegisteredMunicipalUrl("kein-url-string")).toBe(false);
    expect(isRegisteredMunicipalUrl(`https://x${host}/y.pdf`)).toBe(false);
  });
});
