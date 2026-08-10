import { randomUUID } from "node:crypto";
import type { EventEnvelope, Id } from "@xmaster-center/contracts";

export type EventDeliveryState = {
  attempts: number;
  nextAttemptAt: Date | null;
  deadLetter: boolean;
  successfulHandlers: string[];
};

export type EventRepository = {
  append(event: EventEnvelope): Promise<EventEnvelope>;
  pending(limit: number, now?: Date): Promise<EventEnvelope[]>;
  state(eventId: string): Promise<EventDeliveryState>;
  recordHandlerSuccess(eventId: string, handlerKey: string): Promise<void>;
  recordHandlerFailure(
    eventId: string,
    input: { nextAttemptAt: Date; deadLetter: boolean },
  ): Promise<void>;
  requeue(eventId: string): Promise<EventEnvelope | null>;
  markPublished(id: string): Promise<void>;
};

export type EventExecutor = Pick<EventRepository, "append">;
export type EventHandler = (event: EventEnvelope) => Promise<void>;
export type EventSubscription = { name: string; handle: EventHandler };

export type EventBusOptions = {
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  now?: () => Date;
};

export function createEventBus(
  repository: EventRepository,
  subscriptions: EventSubscription[],
  options: EventBusOptions = {},
) {
  const handlers = new Map<
    string,
    Array<{ key: string; handle: EventHandler }>
  >();
  for (const [index, subscription] of subscriptions.entries()) {
    const list = handlers.get(subscription.name) ?? [];
    list.push({
      key: `${subscription.name}:${index}`,
      handle: subscription.handle,
    });
    handlers.set(subscription.name, list);
  }
  const now = options.now ?? (() => new Date());
  const maxAttempts = options.maxAttempts ?? 5;
  const backoffMs =
    options.backoffMs ??
    ((attempt) => Math.min(300_000, 1_000 * 2 ** Math.max(0, attempt - 1)));

  return {
    async publish(
      input: Omit<EventEnvelope, "id" | "occurredAt">,
      executor: EventExecutor = repository,
    ) {
      return executor.append({ ...input, id: randomUUID(), occurredAt: now() });
    },
    async dispatch(limit = 100) {
      const pending = await repository.pending(limit, now());
      let delivered = 0;
      for (const event of pending) {
        const state = await repository.state(event.id);
        const eventHandlers = handlers.get(event.name) ?? [];
        let failed = false;
        for (const handler of eventHandlers) {
          if (state.successfulHandlers.includes(handler.key)) continue;
          try {
            await handler.handle(event);
            await repository.recordHandlerSuccess(event.id, handler.key);
          } catch {
            failed = true;
            const attempts = state.attempts + 1;
            await repository.recordHandlerFailure(event.id, {
              nextAttemptAt: new Date(now().getTime() + backoffMs(attempts)),
              deadLetter: attempts >= maxAttempts,
            });
            break;
          }
        }
        if (failed) continue;
        await repository.markPublished(event.id);
        delivered += 1;
      }
      return delivered;
    },
  };
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

export { MemoryEventRepository } from "./events-memory.js";
export { createDrizzleEventRepository } from "./events-drizzle.js";
