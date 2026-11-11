import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import type { Role } from '../src/schemas.ts';
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
