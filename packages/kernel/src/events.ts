import { randomUUID } from "node:crypto";
import type { EventEnvelope, Id } from "@xmaster-center/contracts";

export type EventRepository = {
  append(event: EventEnvelope): Promise<void>;
  pending(limit: number): Promise<EventEnvelope[]>;
  markPublished(id: string): Promise<void>;
};

export type EventHandler = (event: EventEnvelope) => Promise<void>;
export type EventSubscription = { name: string; handle: EventHandler };

export function createEventBus(
  repository: EventRepository,
  subscriptions: EventSubscription[],
) {
  const handlers = new Map<string, EventHandler[]>();
  for (const subscription of subscriptions) {
    const list = handlers.get(subscription.name) ?? [];
    list.push(subscription.handle);
    handlers.set(subscription.name, list);
  }
  return {
    async publish(input: Omit<EventEnvelope, "id" | "occurredAt">) {
      const event: EventEnvelope = {
        ...input,
        id: randomUUID(),
        occurredAt: new Date(),
      };
      await repository.append(event);
      return event;
    },
    async dispatch(limit = 100) {
      const pending = await repository.pending(limit);
      let delivered = 0;
      for (const event of pending) {
        const eventHandlers = handlers.get(event.name) ?? [];
        for (const handler of eventHandlers) await handler(event);
        await repository.markPublished(event.id);
        delivered += 1;
      }
      return delivered;
    },
  };
}

export class MemoryEventRepository implements EventRepository {
  readonly events: Array<EventEnvelope & { publishedAt?: Date }> = [];
  async append(event: EventEnvelope) {
    this.events.push(event);
  }
  async pending(limit: number) {
    return this.events.filter((event) => !event.publishedAt).slice(0, limit);
  }
  async markPublished(id: string) {
    const event = this.events.find((item) => item.id === id);
    if (event) event.publishedAt = new Date();
  }
}

export function eventInput(
  tenantId: string,
  name: string,
  aggregateType: string,
  aggregateId: Id,
  payload: Record<string, unknown>,
  idempotencyKey: string,
) {
  return {
    tenantId,
    name,
    aggregateType,
    aggregateId,
    payload,
    idempotencyKey,
  };
}
