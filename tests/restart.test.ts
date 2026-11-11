import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import type { Role } from '../src/schemas.ts';
import { taskViews } from '../src/task-view.ts';
import { goodOutput, type Step } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

type Tuloy = ReturnType<typeof testTuloy>;
const trail = ({ store }: Tuloy, runId: number, taskId: string) => store.events(runId).filter((e) => e.taskId === taskId).map((e) => `${e.action} ${e.result}`);
const newFile = () => join(mkdtempSync(join(tmpdir(), 'tuloy-')), 'tuloy.sqlite');

/**
 * Starts the sample run in a Tuloy on `file` and stops that Tuloy (its store closes, as when the program dies)
 * at the moment the event `at` of the scripts task is written. Returns the id of the run that was left not finished.
 */
async function stopInTheMiddle(file: string, at: string, script?: Partial<Record<Role, Step[]>>): Promise<number> {
  const { conductor, store } = testTuloy({ file, script });
  let seen = 0;
  store.subscribe((e) => {
    if (e.taskId === 'scripts' && `${e.action} ${e.result}` === at.replace(/^2nd /, '') && ++seen === (at.startsWith('2nd ') ? 2 : 1)) store.close();
  });
  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended.catch(() => {}); // the stopped conductor dies on the closed store
  return runId;
}

test('a run that was stopped in the middle continues after a restart and ends as done; done tasks are not run again', async () => {
  const file = newFile();
  const runId = await stopInTheMiddle(file, 'dispatch started');

  const tuloy = testTuloy({ file });
  const { conductor, store, model } = tuloy;
  expect(store.run(runId)?.status).toBe('running');
  expect(store.tasks(runId).map((t) => t.status)).toEqual(['done', 'running', 'waiting_on_dependency', 'waiting_on_dependency']);

  const continued = conductor.continueRuns();
  expect(continued.map((c) => c.runId)).toEqual([runId]);
  await continued[0].ended;

  expect(store.run(runId)?.status).toBe('done');
  expect(store.tasks(runId).map((t) => t.status)).toEqual(['done', 'done', 'done', 'done']);
  expect(store.tasks(runId)[3].output).toEqual(goodOutput.scheduler);
  // The trend scout was done before the stop: no second model call, no second start.
  expect(model.calls.map((c) => c.role)).toEqual(['script', 'reviewer', 'scheduler']);
  expect(trail(tuloy, runId, 'trends').filter((line) => line === 'dispatch started')).toHaveLength(1);
});

test('a task that was running at the stop gets a stalled status, an event that names the restart, and normal recovery', async () => {
  const file = newFile();
  const runId = await stopInTheMiddle(file, 'dispatch started');

  const tuloy = testTuloy({ file });
  const { conductor, store, clock } = tuloy;
  const restartedAt = clock.now();
  // The state of the scripts task at the moment the conductor starts the wait for its retry.
  let duringTheWait: unknown;
  store.subscribe((e) => {
    if (e.action === 'retry') duringTheWait = taskViews(store.tasks(runId), store.events(runId)).find((t) => t.id === 'scripts');
  });

  await conductor.continueRuns()[0].ended;

  expect(duringTheWait).toMatchObject({
    status: 'stalled_heartbeat',
    shownStatus: 'stalled',
    stuckReason: 'Script task stalled: Tuloy restarted while the task was in work. Retry 1 of 2 in 2s.',
  });
  expect(trail(tuloy, runId, 'scripts')).toEqual([
    'assign script',
    'handoff checked content stored',
    'dispatch started',
    // the stop was here
    'watch missed_heartbeat',
    'retry waiting',
    'dispatch started',
    'validate valid',
    'review pass',
  ]);
  const events = store.events(runId);
  expect(events.find((e) => e.action === 'restart')).toMatchObject({ taskId: null, result: 'continued', cause: 'Tuloy started again before this run ended', time: restartedAt });
  expect(events.find((e) => e.action === 'watch')).toMatchObject({ taskId: 'scripts', cause: 'Tuloy restarted while the task was in work' });
  expect(events.findLast((e) => e.action === 'dispatch' && e.taskId === 'scripts')).toMatchObject({ cause: 'retry 1 of 2', time: restartedAt + 2000 });
  expect(store.run(runId)?.status).toBe('done');
});
