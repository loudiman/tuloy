import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { nextAction, type Failure } from '../src/recovery-policy.ts';
import { createServer } from '../src/server.ts';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { taskViews } from '../src/task-view.ts';
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

test('the stuck reason names the rejection and its main issue, and what the conductor does about it', async () => {
  const tuloy = testTuloy({ script: { reviewer: [rejection, rejection, rejection] } });
  const { conductor, store } = tuloy;
  /** The stuck reason and shown status of the script task, read at each recovery event. */
  const seen: (string | null)[][] = [];
  store.subscribe((e) => {
    if (e.taskId !== 'scripts' || !['retry', 'dispatch', 'escalate'].includes(e.action)) return;
    const view = taskViews(store.tasks(e.runId), store.events(e.runId)).find((t) => t.id === 'scripts')!;
    seen.push([`${e.action} ${e.result}`, view.shownStatus, view.stuckReason]);
  });

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(seen).toEqual([
    ['dispatch started', 'running', null],
    ['retry waiting', 'stalled', 'Script task rejected by the reviewer: The hook is weak. Retry 1 of 2 in 2s.'],
    ['dispatch started', 'recovering', 'Script task rejected by the reviewer: The hook is weak. Retry 1 of 2 is running.'],
    ['retry waiting', 'stalled', 'Script task rejected by the reviewer: The hook is weak. Retry 2 of 2 in 4s.'],
    ['dispatch started', 'recovering', 'Script task rejected by the reviewer: The hook is weak. Retry 2 of 2 is running.'],
    ['escalate escalated', 'stalled', 'Script task rejected by the reviewer: The hook is weak. 2 of 2 retries used. The run ended as escalated.'],
  ]);
  expect(taskViews(store.tasks(runId), store.events(runId)).find((t) => t.id === 'scripts')).toMatchObject({
    shownStatus: 'escalated',
    stuckReason: 'Script task rejected by the reviewer: The hook is weak. 2 of 2 retries used. The run ended as escalated.',
  });
});

test('the recovery policy retries a reviewer rejection like any failure of the script task, up to the limit', () => {
  const limits = { retries: 2, retryWaitMs: 2000 };
  const rejected: Failure = { kind: 'reviewer_rejection', detail: 's1: The hook is weak.' };
  const junk: Failure = { kind: 'invalid_output', detail: 'x' };

  expect(nextAction(rejected, [], limits)).toEqual({ do: 'retry', retry: 1, of: 2, waitMs: 2000 });
  expect(nextAction(rejected, [junk], limits)).toEqual({ do: 'retry', retry: 2, of: 2, waitMs: 4000 });
  expect(nextAction(rejected, [junk, rejected], limits)).toEqual({ do: 'escalate', cause: '2 of 2 retries used' });
});

test('demo mode: an injected reviewer rejection sends the script back one time, with no call to the reviewer model for it', async () => {
  const tuloy = testTuloy();
  const server = createServer({ store: tuloy.store, conductor: tuloy.conductor, owner: 'Lou', demo: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const posted = await fetch(`${url}/api/injections`, { method: 'POST', body: JSON.stringify({ task: 'script', kind: 'reviewer_rejection' }) });
    expect(posted.status).toBe(201);
    expect(await posted.json()).toMatchObject({ task: 'script', kind: 'reviewer_rejection' });

    const { runId, ended } = tuloy.conductor.startRun(SAMPLE_GOAL);
    await ended;

    expect(tuloy.store.run(runId)?.status).toBe('done');
    expect(trail(tuloy, runId, 'scripts')).toEqual([
      'assign script',
      'handoff checked content stored',
      'dispatch started',
      'injection reviewer_rejection',
      'validate valid',
      'review rejected',
      'retry waiting',
      'handoff checked content stored',
      'dispatch started',
      'validate valid',
      'review pass',
    ]);
    // The injected rejection is a full rejection: verdict, score, issues, hints. The script agent gets it as input.
    const review = tuloy.store.events(runId).find((e) => e.action === 'review')!;
    expect((review.data as typeof rejection).reviews[0]).toEqual({ script_id: 's1', verdict: 'reject', score: 2, issues: ['Demo: the presenter injected this rejection.'], hints: ['Write the script again.'] });
    const scriptCalls = tuloy.model.calls.filter((c) => c.role === 'script').map((c) => JSON.parse(c.prompt));
    expect(scriptCalls[1].reviewer_hints).toEqual([{ script_id: 's1', issues: ['Demo: the presenter injected this rejection.'], hints: ['Write the script again.'] }]);
    expect(tuloy.model.calls.filter((c) => c.role === 'reviewer')).toHaveLength(1);
    expect(await (await fetch(`${url}/api/injections`)).json()).toEqual({ demo: true, injections: [] });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
