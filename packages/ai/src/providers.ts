import OpenAI from "openai";
import { AiError } from "./errors.js";
import type {
  AiProvider,
  ChatInput,
  ChatOutput,
  ImageInput,
  ImageOutput,
  TranscribeInput,
  TranscribeOutput,
  Usage,
  VisionInput,
} from "./types.js";

const noUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
});

export class MockProvider implements AiProvider {
  readonly name = "mock";
  constructor(private readonly response = "mock response") {}
  async chat(_input: ChatInput): Promise<ChatOutput> {
    return { text: this.response, usage: noUsage() };
  }
  async vision(_input: VisionInput): Promise<ChatOutput> {
    return { text: this.response, usage: noUsage() };
  }
  async image(_input: ImageInput): Promise<ImageOutput> {
    return { url: null, usage: noUsage() };
  }
  async transcribe(_input: TranscribeInput): Promise<TranscribeOutput> {
    return { text: this.response, usage: noUsage() };
  }
}

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  constructor(private readonly client: OpenAI) {}
  static fromKey(apiKey?: string) {
    if (!apiKey)
      throw new AiError(
        "PROVIDER_NOT_CONFIGURED",
        "OPENAI_API_KEY ist nicht konfiguriert",
      );
    return new OpenAiProvider(new OpenAI({ apiKey }));
  }
  async chat(input: ChatInput): Promise<ChatOutput> {
    const response = await this.client.chat.completions.create({
      model: input.model,
      messages: input.messages,
      ...(input.temperature === undefined
        ? {}
        : { temperature: input.temperature }),
      ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
    });
    return {
      text: response.choices[0]?.message.content ?? "",
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        costMicros: 0,
      },
      raw: response,
    };
  }
  async vision(input: VisionInput) {
    return this.chat({
      ...input,
      messages: input.messages.map((message) =>
        message.role === "user"
          ? {
              ...message,
              content: `${message.content}\nBildquelle: ${input.imageUrl}`,
            }
          : message,
      ),
    });
  }
  async image(input: ImageInput): Promise<ImageOutput> {
    const response = await this.client.images.generate({
      model: input.model,
      prompt: input.prompt,
      size: input.size as any,
    });
    return {
      url: response.data?.[0]?.url ?? null,
      usage: noUsage(),
      raw: response,
    };
  }
  async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
    const file = new File(
      [Buffer.from(input.audio)],
      input.filename ?? "audio.bin",
    );
    const response = await this.client.audio.transcriptions.create({
      model: input.model,
      file,
    });
    return { text: response.text, usage: noUsage(), raw: response };
  }
}

export type HttpProviderOptions = {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

export class HttpProvider implements AiProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: HttpProviderOptions) {
    this.name = options.name;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  private ensureConfigured() {
    if (!this.options.baseUrl || !this.options.apiKey) {
      throw new AiError(
        "PROVIDER_NOT_CONFIGURED",
        `${this.name} ist nicht konfiguriert`,
      );
    }
  }
  private async request<T>(path: string, body: unknown): Promise<T> {
    this.ensureConfigured();
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${this.name} HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }
  async chat(input: ChatInput): Promise<ChatOutput> {
    return this.request("/chat", input);
  }
  async vision(input: VisionInput): Promise<ChatOutput> {
    return this.request<ChatOutput>("/vision", input);
  }
  async image(input: ImageInput): Promise<ImageOutput> {
    return this.request<ImageOutput>("/image", input);
  }
  async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
    return this.request<TranscribeOutput>("/transcribe", {
      ...input,
      audio: Buffer.from(input.audio).toString("base64"),
    });
  }
}

export function createProviderRegistry(config: {
  openaiKey?: string;
  gemini?: HttpProviderOptions;
  xai?: HttpProviderOptions;
  manusForge?: HttpProviderOptions;
}) {
  const providers = new Map<string, AiProvider>([
    ["gemini", new HttpProvider({ name: "gemini", ...config.gemini })],
    ["xai", new HttpProvider({ name: "xai", ...config.xai })],
    [
      "manus-forge",
      new HttpProvider({ name: "manus-forge", ...config.manusForge }),
    ],
  ]);
  if (config.openaiKey)
    providers.set("openai", OpenAiProvider.fromKey(config.openaiKey));
  return {
    get(name: string) {
      const provider = providers.get(name);
      if (!provider)
        throw new AiError(
          "PROVIDER_NOT_CONFIGURED",
          `Provider nicht konfiguriert: ${name}`,
        );
      return provider;
    },
    register(provider: AiProvider) {
      if (providers.has(provider.name))
        throw new Error(`Provider bereits registriert: ${provider.name}`);
      providers.set(provider.name, provider);
    },
  };
}
