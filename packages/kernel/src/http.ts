export function responseErrorMessage(
  body: string,
  status: number,
): string {
  const rawBody = body.trim();
  if (rawBody) {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (
        parsed &&
        typeof parsed === "object" &&
        "detail" in parsed &&
        typeof parsed.detail === "string" &&
        parsed.detail.trim()
      ) {
        return parsed.detail;
      }
    } catch {}
    return rawBody;
  }
  return `HTTP ${status}`;
}
