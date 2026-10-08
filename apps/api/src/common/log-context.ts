import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Fields added to every log line written inside a unit of work (a background
 * job), via pino's `mixin`. This way the LLM client and grounding code can log
 * without being handed the CV id.
 */
const storage = new AsyncLocalStorage<Record<string, unknown>>();

export function withLogContext<T>(fields: Record<string, unknown>, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...fields }, fn);
}

/**
 * A copy: pino merges each line's own fields into the object `mixin` returns,
 * so handing out the store itself would leak one line's fields into the next.
 */
export function logContext(): Record<string, unknown> {
  return { ...storage.getStore() };
}
