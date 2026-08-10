export class AiError extends Error {
  constructor(
    public readonly code:
      | "PROVIDER_NOT_CONFIGURED"
      | "BUDGET_EXCEEDED"
      | "CONTENT_ANCHOR_VIOLATION"
      | "PROMPT_NOT_APPROVED"
      | "HUMAN_APPROVAL_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}
