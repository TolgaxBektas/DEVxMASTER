export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
};
export type ChatInput = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
};
export type VisionInput = ChatInput & { imageUrl: string };
export type ImageInput = { model: string; prompt: string; size?: string };
export type TranscribeInput = {
  model: string;
  audio: Uint8Array;
  filename?: string;
};
export type ChatOutput = { text: string; usage: Usage; raw?: unknown };
export type ImageOutput = {
  url: string | null;
  bytes?: Uint8Array;
  usage: Usage;
  raw?: unknown;
};
export type TranscribeOutput = { text: string; usage: Usage; raw?: unknown };

export type AiProvider = {
  name: string;
  chat(input: ChatInput): Promise<ChatOutput>;
  vision(input: VisionInput): Promise<ChatOutput>;
  image(input: ImageInput): Promise<ImageOutput>;
  transcribe(input: TranscribeInput): Promise<TranscribeOutput>;
};

export type PromptStatus = "draft" | "approved" | "retired";
export type PromptVersion = {
  key: string;
  version: string;
  body: string;
  status: PromptStatus;
  sha256: string;
};

export type UsageLedger = {
  record(entry: {
    tenantId: string;
    provider: string;
    model: string;
    operation: string;
    usage: Usage;
    objectType?: string;
    objectId?: string;
  }): Promise<void>;
  totalCost(tenantId: string, objectId?: string): Promise<number>;
};

export type Budget = {
  tenantId: string;
  maxCostMicros: number;
  objectId?: string;
};

export type ContentAnchor = { key: string; value: string; category: string };
