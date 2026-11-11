import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { goodOutput } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

type Tuloy = ReturnType<typeof testTuloy>;
/** The events of one task as short lines: "action result". */
const trail = ({ store }: Tuloy, runId: number, taskId: string) => store.events(runId).filter((e) => e.taskId === taskId).map((e) => `${e.action} ${e.result}`);

/** The reviewer rejects script s1 and passes s2. */
const rejection = {
  reviews: [
    { script_id: 's1', verdict: 'reject', score: 3, issues: ['The hook is weak.', 'The cta has two actions.'], hints: ['Open with a question.'] },
    { script_id: 's2', verdict: 'pass', score: 8, issues: [], hints: [] },
  ],
};

test('a rejected script is written again with the reviewer’s issues and hints; after a pass the scheduler starts and the run ends as done', async () => {
  const tuloy = testTuloy({ script: { reviewer: [rejection] } });
  const { conductor, store, model } = tuloy;

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  expect(store.tasks(runId).map((t) => [t.id, t.status])).toEqual([
    ['trends', 'done'],
    ['scripts', 'done'],
    ['review', 'done'],
    ['schedule', 'done'],
  ]);
  expect(trail(tuloy, runId, 'scripts')).toEqual([
    'assign script',
    'handoff checked content stored',
    'dispatch started',
    'validate valid',
    'review rejected',
    'retry waiting',
    'handoff checked content stored',
    'dispatch started',
    'validate valid',
    'review pass',
  ]);

  // The second attempt of the script agent gets the issues and hints of the rejected script, and only of that one.
  const hints = [{ script_id: 's1', issues: ['The hook is weak.', 'The cta has two actions.'], hints: ['Open with a question.'] }];
  const scriptCalls = model.calls.filter((c) => c.role === 'script').map((c) => JSON.parse(c.prompt));
  expect(scriptCalls).toHaveLength(2);
  expect(scriptCalls[0].reviewer_hints).toBeUndefined();
  expect(scriptCalls[1]).toEqual({ goal: SAMPLE_GOAL, ...(goodOutput.trend_scout as object), reviewer_hints: hints });

  // The scheduler starts only after the pass.
  const events = store.events(runId);
  const pass = events.find((e) => e.action === 'review' && e.result === 'pass')!;
  expect(events.filter((e) => e.taskId === 'schedule').every((e) => e.seq > pass.seq)).toBe(true);
});

test('a script that is still rejected when the retries are used is never scheduled, and the run ends as escalated', async () => {
  const tuloy = testTuloy({ script: { reviewer: [rejection, rejection, rejection, rejection] } });
  const { conductor, store, model } = tuloy;

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('escalated');
  expect(store.tasks(runId).map((t) => [t.id, t.status])).toEqual([
    ['trends', 'done'],
    ['scripts', 'escalated'],
    ['review', 'waiting_on_dependency'],
    ['schedule', 'waiting_on_dependency'],
  ]);
  // One first attempt and two retries of the script, each with its review. Not one more.
  expect(model.calls.map((c) => c.role)).toEqual(['trend_scout', 'script', 'reviewer', 'script', 'reviewer', 'script', 'reviewer']);
  expect(store.events(runId).slice(-3)).toMatchObject([
    { taskId: 'scripts', action: 'review', result: 'rejected', cause: 's1: The hook is weak. The cta has two actions.', data: rejection },
    { taskId: 'scripts', action: 'escalate', result: 'escalated', cause: '2 of 2 retries used' },
    { taskId: null, action: 'end', result: 'escalated' },
  ]);
  // A rejection has a verdict, a score and a list of issues.
  expect(store.events(runId).filter((e) => e.action === 'review').map((e) => (e.data as typeof rejection).reviews[0])).toEqual(Array(3).fill(rejection.reviews[0]));
  expect(store.events(runId).some((e) => e.taskId === 'schedule')).toBe(false);
});
