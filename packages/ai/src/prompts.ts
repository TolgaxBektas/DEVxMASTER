import { createHash } from "node:crypto";
import { AiError } from "./errors.js";
import type { PromptVersion } from "./types.js";

export interface PromptRepository {
  find(key: string, version?: string): Promise<PromptVersion | null>;
}

export class MemoryPromptRepository implements PromptRepository {
  private readonly prompts = new Map<string, PromptVersion>();
  add(prompt: Omit<PromptVersion, "sha256">) {
    const sha256 = createHash("sha256")
      .update(prompt.body, "utf8")
      .digest("hex");
    this.prompts.set(`${prompt.key}:${prompt.version}`, { ...prompt, sha256 });
  }
  async find(key: string, version?: string) {
    const matches = [...this.prompts.values()].filter(
      (item) => item.key === key,
    );
    return (
      (version
        ? matches.find((item) => item.version === version)
        : matches.find((item) => item.status === "approved")) ?? null
    );
  }
}

export async function requireApprovedPrompt(
  repository: PromptRepository,
  key: string,
  version?: string,
) {
  const prompt = await repository.find(key, version);
  if (!prompt || prompt.status !== "approved") {
    throw new AiError(
      "PROMPT_NOT_APPROVED",
      `Prompt ist nicht freigegeben: ${key}${version ? `@${version}` : ""}`,
    );
  }
  return prompt;
}
