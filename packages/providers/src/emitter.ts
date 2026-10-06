/** A typed event emitter for browsers and Node alike (node:events doesn't exist in the extension). */
export class Emitter<E extends { [K in keyof E]: (...args: any[]) => void }> {
  private listeners = new Map<keyof E, Set<E[keyof E]>>();

  on<K extends keyof E>(event: K, listener: E[K]): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }

  off<K extends keyof E>(event: K, listener: E[K]): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  protected emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    // A copy: a listener may remove itself (or add others) while this runs.
    for (const fn of Array.from(this.listeners.get(event) ?? [])) (fn as (...a: Parameters<E[K]>) => void)(...args);
  }
}
