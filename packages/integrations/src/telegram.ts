export type Telegram = {
  sendText(chatId: string, text: string): Promise<{ messageId: string }>;
  sendApprovalRequest(input: {
    chatId: string;
    text: string;
    callbackData: string;
  }): Promise<{ messageId: string }>;
};

export class NoopTelegram implements Telegram {
  readonly messages: Array<{ chatId: string; text: string }> = [];
  async sendText(chatId: string, text: string) {
    this.messages.push({ chatId, text });
    return { messageId: `noop-${this.messages.length}` };
  }
  sendApprovalRequest(input: {
    chatId: string;
    text: string;
    callbackData: string;
  }) {
    return this.sendText(
      input.chatId,
      `${input.text}\n[callback:${input.callbackData}]`,
    );
  }
}

export class HttpTelegram implements Telegram {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async call(method: string, body: Record<string, unknown>) {
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
    const data = (await response.json()) as {
      result?: { message_id?: number };
    };
    return { messageId: String(data.result?.message_id ?? "") };
  }
  sendText(chatId: string, text: string) {
    return this.call("sendMessage", { chat_id: chatId, text });
  }
  sendApprovalRequest(input: {
    chatId: string;
    text: string;
    callbackData: string;
  }) {
    return this.call("sendMessage", {
      chat_id: input.chatId,
      text: input.text,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Freigeben", callback_data: input.callbackData }],
        ],
      },
    });
  }
}
