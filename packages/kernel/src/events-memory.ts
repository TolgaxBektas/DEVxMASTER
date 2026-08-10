import type { EventEnvelope } from "@xmaster-center/contracts";
import type { EventDeliveryState, EventRepository } from "./events.js";

type StoredEvent = EventEnvelope & {
  publishedAt?: Date;
  delivery: EventDeliveryState;
};

export class MemoryEventRepository implements EventRepository {
  readonly events: StoredEvent[] = [];

  async append(event: EventEnvelope): Promise<EventEnvelope> {
    const existing = this.events.find(
      (item) => item.idempotencyKey === event.idempotencyKey,
    );
    if (existing) return existing;
    this.events.push({
      ...event,
      delivery: {
        attempts: 0,
        nextAttemptAt: null,
        deadLetter: false,
        successfulHandlers: [],
      },
    });
    return event;
  }

  async pending(limit: number, now = new Date()) {
    return this.events
      .filter(
        (event) =>
          !event.publishedAt &&
          !event.delivery.deadLetter &&
          (!event.delivery.nextAttemptAt ||
            event.delivery.nextAttemptAt <= now),
      )
      .slice(0, limit);
  }

  async state(eventId: string) {
    const event = this.events.find((item) => item.id === eventId);
    if (!event) throw new Error(`Event nicht gefunden: ${eventId}`);
    return {
      ...event.delivery,
      successfulHandlers: [...event.delivery.successfulHandlers],
    };
  }

  async recordHandlerSuccess(eventId: string, handlerKey: string) {
    const event = this.events.find((item) => item.id === eventId);
    if (event && !event.delivery.successfulHandlers.includes(handlerKey)) {
      event.delivery.successfulHandlers.push(handlerKey);
    }
  }

  async recordHandlerFailure(
    eventId: string,
    input: { nextAttemptAt: Date; deadLetter: boolean },
  ) {
    const event = this.events.find((item) => item.id === eventId);
    if (event) {
      event.delivery.attempts += 1;
      event.delivery.nextAttemptAt = input.nextAttemptAt;
      event.delivery.deadLetter = input.deadLetter;
    }
  }

  async markPublished(id: string) {
    const event = this.events.find((item) => item.id === id);
    if (event) event.publishedAt = new Date();
  }
}
