import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { goodOutput } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

type Tuloy = ReturnType<typeof testTuloy>;
/** The events of one task as short lines: "action result". */
const trail = ({ store }: Tuloy, runId: number, taskId: string) => store.events(runId).filter((e) => e.taskId === taskId).map((e) => `${e.action} ${e.result}`);
const task = ({ store }: Tuloy, runId: number, taskId: string) => store.tasks(runId).find((t) => t.id === taskId)!;
const junk = { scripts: 'junk' };

test('after the retry limit, the task is re-routed to the backup model with the same input, and the run ends as done', async () => {
  const tuloy = testTuloy({ script: { script: [junk, junk, junk, junk] }, backupScript: {} });
  const { conductor, store, model, backup } = tuloy;

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
    'validate invalid_output',
    'retry waiting',
    'dispatch started',
    'validate invalid_output',
    'reroute backup model',
    'dispatch started',
    'validate valid',
    'review pass',
  ]);
  const primaryCalls = model.calls.filter((c) => c.role === 'script');
  expect(primaryCalls).toHaveLength(3);
  // The backup model gets the one task, with the same checked input.
  expect(backup.calls).toEqual([{ ...primaryCalls[0] }]);
  const switched = store.events(runId).find((e) => e.action === 'reroute');
  expect(switched).toMatchObject({ taskId: 'scripts', cause: '2 of 2 retries used', result: 'backup model' });
});
