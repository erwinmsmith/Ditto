export interface RuntimeEvent<T = unknown> {
  readonly type: string;
  readonly payload: T;
}

export type EventHandler = (event: RuntimeEvent) => void | Promise<void>;
export interface EventFailure {
  readonly event: RuntimeEvent;
  readonly error: unknown;
}

/** Adapters may provide IPC or Pub/Sub; emit acknowledges acceptance only. */
export interface EventFabric {
  emit<T>(event: RuntimeEvent<T>): Promise<void>;
  subscribe(type: string, handler: EventHandler): () => boolean;
  drain(): Promise<readonly EventFailure[]>;
}

export class LocalEventFabric implements EventFabric {
  readonly #handlers = new Map<string, Set<EventHandler>>();
  readonly #pending = new Set<Promise<void>>();
  readonly #failures: EventFailure[] = [];

  async emit<T>(event: RuntimeEvent<T>): Promise<void> {
    // Snapshot subscribers; one failure must not block any other consumer.
    for (const handler of [...(this.#handlers.get(event.type) ?? [])]) {
      const task = Promise.resolve()
        .then(() => handler(event))
        .catch((error: unknown) => { this.#failures.push({ event, error }); });
      this.#pending.add(task);
      void task.then(() => { this.#pending.delete(task); });
    }
  }

  subscribe(type: string, handler: EventHandler): () => boolean {
    const handlers = this.#handlers.get(type) ?? new Set<EventHandler>();
    // A distinct wrapper gives each subscription independent ownership.
    const subscriber: EventHandler = (event) => handler(event);
    handlers.add(subscriber);
    this.#handlers.set(type, handlers);
    return () => {
      const removed = handlers.delete(subscriber);
      if (removed && handlers.size === 0 && this.#handlers.get(type) === handlers) {
        this.#handlers.delete(type);
      }
      return removed;
    };
  }

  async drain(): Promise<readonly EventFailure[]> {
    while (this.#pending.size) await Promise.all([...this.#pending]);
    return this.#failures.splice(0);
  }
}
