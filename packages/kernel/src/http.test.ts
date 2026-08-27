import { describe, expect, it } from "vitest";
import { responseErrorMessage } from "./http.js";

describe("responseErrorMessage", () => {
  it("bevorzugt detail aus JSON", () => {
    expect(responseErrorMessage('{"detail":"abgelehnt"}', 400)).toBe("abgelehnt");
  });

  it("verwendet sonst Rohtext oder Statuszeile", () => {
    expect(responseErrorMessage("Service nicht erreichbar", 503)).toBe(
      "Service nicht erreichbar",
    );
    expect(responseErrorMessage(" ", 503)).toBe("HTTP 503");
  });
});
