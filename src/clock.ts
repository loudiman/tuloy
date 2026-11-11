import { setTimeout as wait } from 'node:timers/promises';

/** The time source of one Tuloy. Tests swap it, so that waits and time limits take no real time. */
export type Clock = {
  now(): number;
  /** Resolves after `ms`, or at once when `signal` aborts. It never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export const systemClock: Clock = {
  now: Date.now,
  sleep: (ms, signal) => wait(ms, undefined, { signal }).catch(() => {}),
};
