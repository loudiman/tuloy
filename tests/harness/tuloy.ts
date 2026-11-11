import type { Clock } from '../../src/clock.ts';
import { createConductor } from '../../src/conductor.ts';
import { defaultLimits, type Limits } from '../../src/settings.ts';
import { openStore } from '../../src/store.ts';
import { scriptedModel, type Step } from './scripted-model.ts';
import type { Role } from '../../src/schemas.ts';

/**
 * A clock that takes no real time. Starts at 2026-11-12 09:00 Manila time.
 * A test can move it with `advance`. It also moves by itself: when a wait (`sleep`) is open and nothing else
 * is ready to run, the clock jumps to the end of the earliest wait. So a test only awaits the end of the run.
 */
export function fakeClock(start = Date.parse('2026-11-12T09:00:00+08:00')): Clock & { advance(ms: number): void } {
  let t = start;
  let jumping = false;
  const waits: { at: number; wake: () => void }[] = [];
  const jump = () =>
    setImmediate(() => {
      const next = waits.sort((a, b) => a.at - b.at).shift();
      if (!next) return void (jumping = false);
      t = Math.max(t, next.at);
      next.wake();
      jump();
    });
  return {
    now: () => t,
    advance: (ms) => void (t += ms),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const open = { at: t + ms, wake: resolve };
        waits.push(open);
        signal?.addEventListener('abort', () => {
          if (waits.includes(open)) waits.splice(waits.indexOf(open), 1);
          resolve();
        });
        if (!jumping) {
          jumping = true;
          jump();
        }
      }),
  };
}

/** One Tuloy for a test: a store (in memory unless `file` is given), a fake clock, a scripted model and a conductor. */
export function testTuloy(options: { script?: Partial<Record<Role, Step[]>>; file?: string; limits?: Partial<Limits> } = {}) {
  const clock = fakeClock();
  const store = openStore(options.file ?? ':memory:', clock);
  const model = scriptedModel(options.script);
  const conductor = createConductor({ store, models: { primary: model, backup: model }, clock, limits: { ...defaultLimits, ...options.limits } });
  return { clock, store, model, conductor };
}
