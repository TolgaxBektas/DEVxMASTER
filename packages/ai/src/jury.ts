import type { AiProvider, ChatInput, ChatOutput } from "./types.js";

export type JuryVariant = ChatOutput & { provider: string; score: number };

export async function runJury(
  providers: readonly AiProvider[],
  input: ChatInput,
  score: (result: ChatOutput, provider: AiProvider) => Promise<number> | number,
): Promise<{ best: JuryVariant; variants: JuryVariant[] }> {
  const variants = await Promise.all(
    providers.map(async (provider) => {
      const result = await provider.chat(input);
      return {
        ...result,
        provider: provider.name,
        score: await score(result, provider),
      };
    }),
  );
  const best = [...variants].sort((a, b) => b.score - a.score)[0];
  if (!best) throw new Error("Jury benötigt mindestens einen Provider");
  return { best, variants };
}
