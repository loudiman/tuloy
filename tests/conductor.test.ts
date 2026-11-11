import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { goodOutput } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

test('a goal becomes a stored task graph and the run ends as done with scripts and a posting schedule', async () => {
  const { conductor, store } = testTuloy();

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)).toMatchObject({ goal: SAMPLE_GOAL, status: 'done' });
  expect(store.tasks(runId).map(({ id, title, dependsOn, role, status }) => ({ id, title, dependsOn, role, status }))).toEqual([
    { id: 'trends', title: 'Find trends', dependsOn: [], role: 'trend_scout', status: 'done' },
    { id: 'scripts', title: 'Write scripts', dependsOn: ['trends'], role: 'script', status: 'done' },
    { id: 'review', title: 'Review scripts', dependsOn: ['scripts'], role: 'reviewer', status: 'done' },
    { id: 'schedule', title: 'Make the posting schedule', dependsOn: ['scripts', 'review'], role: 'scheduler', status: 'done' },
  ]);
  const output = (id: string) => store.tasks(runId).find((t) => t.id === id)?.output;
  expect(output('scripts')).toEqual(goodOutput.script);
  expect(output('schedule')).toEqual(goodOutput.scheduler);
});
