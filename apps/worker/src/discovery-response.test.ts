import { describe, expect, it } from "vitest";
import { mapDiscoveryProposalResponse } from "./discovery-response.js";

describe("print-ingest discovery mapping", () => {
  it("preserves search hit counts and errors alongside proposals", () => {
    expect(mapDiscoveryProposalResponse({
      proposals: [{ url: "https://example.test/file.pdf", score: 0.8 }],
      search_hits: [
        { term: "Broschüre", hits: 7, pdfs: 2, error: null },
        { term: "Wegweiser", hits: 0, pdfs: 0, error: "Suchanbieter ausgefallen" },
      ],
    })).toEqual({
      proposals: [{
        url: "https://example.test/file.pdf",
        score: 0.8,
        metadata: { url: "https://example.test/file.pdf", score: 0.8 },
      }],
      searchHits: [
        { term: "Broschüre", hits: 7, pdfs: 2, error: null },
        { term: "Wegweiser", hits: 0, pdfs: 0, error: "Suchanbieter ausgefallen" },
      ],
    });
  });
});
