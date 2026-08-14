import { AiError } from "./errors.js";
import type { ContentAnchor } from "./types.js";

export function validateContentAnchors(
  text: string,
  anchors: readonly ContentAnchor[],
) {
  const missing = anchors.filter(
    (anchor) =>
      !text.toLocaleLowerCase().includes(anchor.value.toLocaleLowerCase()),
  );
  if (missing.length) {
    throw new AiError(
      "CONTENT_ANCHOR_VIOLATION",
      `Verankerte Fakten fehlen: ${missing.map((item) => item.key).join(", ")}`,
    );
  }
  return true;
}
