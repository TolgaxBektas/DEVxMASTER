import nodemailer, { type Transporter } from "nodemailer";

export type MailMessage = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Uint8Array }>;
};
export type Mail = {
  send(message: MailMessage): Promise<{ messageId: string }>;
};

export class NoopMail implements Mail {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage) {
    this.sent.push(message);
    return { messageId: `noop-${this.sent.length}` };
  }
}

export class NodemailerMail implements Mail {
  constructor(
    private readonly transporter: Transporter,
    private readonly from: string,
  ) {}
  static smtp(options: {
    host: string;
    port: number;
    user?: string;
    pass?: string;
    from: string;
  }) {
    return new NodemailerMail(
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        auth:
          options.user && options.pass
            ? { user: options.user, pass: options.pass }
            : undefined,
      }),
      options.from,
    );
  }
  async send(message: MailMessage) {
    const result = await this.transporter.sendMail({
      ...message,
      from: this.from,
      ...(message.attachments
        ? {
            attachments: message.attachments.map((item) => ({
              ...item,
              content: Buffer.from(item.content),
            })),
          }
        : {}),
    } as any);
    return {
      messageId: String((result as { messageId?: string }).messageId ?? ""),
    };
  }
}
