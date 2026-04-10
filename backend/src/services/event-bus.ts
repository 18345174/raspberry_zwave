import { EventEmitter } from "node:events";

import type { ZwaveEvent } from "../domain/types.js";

export class EventBus {
  private readonly emitter = new EventEmitter();

  publish<T>(event: ZwaveEvent<T>): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: ZwaveEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
