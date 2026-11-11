import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { goodOutput } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

type Tuloy = ReturnType<typeof testTuloy>;
/** The events of one task as short lines: "action result". */
const trail = ({ store }: Tuloy, runId: number, taskId: string) => store.events(runId).filter((e) => e.taskId === taskId).map((e) => `${e.action} ${e.result}`);
const task = ({ store }: Tuloy, runId: number, taskId: string) => store.tasks(runId).find((t) => t.id === taskId)!;

test('an output that fails its schema is retried after a wait, and the run ends as done', async () => {
  const tuloy = testTuloy({ script: { script: [{ scripts: 'junk' }] } });
  const { conductor, store, clock } = tuloy;
  const start = clock.now();

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  expect(task(tuloy, runId, 'scripts')).toMatchObject({ status: 'done', output: goodOutput.script });
  expect(trail(tuloy, runId, 'scripts')).toEqual([
    'assign script',
    'handoff checked content stored',
    'dispatch started',
    'validate invalid_output',
    'retry waiting',
    'dispatch started',
    'validate valid',
    'review pass',
  ]);
  const events = store.events(runId).filter((e) => e.taskId === 'scripts');
  expect(events[4]).toMatchObject({ time: start, cause: 'invalid_output', data: { retry: 1, of: 2, waitMs: 2000 } });
  expect(events[5]).toMatchObject({ time: start + 2000, cause: 'retry 1 of 2' });
});
