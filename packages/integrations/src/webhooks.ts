import { createHmac } from "node:crypto";
import type { LeaseQueue } from "@xmaster-center/jobs";

export type WebhookDelivery = {
  id: string;
  url: string;
  event: string;
  payload: unknown;
  secret: string;
};
export type Webhook = { deliver(input: WebhookDelivery): Promise<void> };

export class SignedWebhook implements Webhook {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async deliver(input: WebhookDelivery) {
    const body = JSON.stringify(input.payload);
    const signature = createHmac("sha256", input.secret)
      .update(body)
      .digest("hex");
    const response = await this.fetchImpl(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xmc-event": input.event,
        "x-xmc-signature": signature,
      },
      body,
    });
    if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
  }
}

export function enqueueWebhook(queue: LeaseQueue, delivery: WebhookDelivery) {
  return queue.enqueue({
    name: "integrations.webhook.deliver",
    payload: delivery,
  });
}
