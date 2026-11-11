import { createConductor } from '../../src/conductor.ts';
import { openStore } from '../../src/store.ts';
import { scriptedModel, type Step } from './scripted-model.ts';
import type { Role } from '../../src/schemas.ts';

/** A clock that moves only when a test moves it. Starts at 2026-11-12 09:00 Manila time. */
export function fakeClock(start = Date.parse('2026-11-12T09:00:00+08:00')) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

/** One Tuloy for a test: a store (in memory unless `file` is given), a fake clock, a scripted model and a conductor. */
export function testTuloy(options: { script?: Partial<Record<Role, Step[]>>; file?: string } = {}) {
  const clock = fakeClock();
  const store = openStore(options.file ?? ':memory:', clock);
  const model = scriptedModel(options.script);
  const conductor = createConductor({ store, clock, models: { primary: model, backup: model } });
  return { clock, store, model, conductor };
}
