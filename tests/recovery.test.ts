import { APICallError } from 'ai';
import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { taskViews } from '../src/task-view.ts';
import { goodOutput, hang, slow } from './harness/scripted-model.ts';
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

test('retries wait longer each time and stop at the hard limit; then the run ends as escalated', async () => {
  const junk = { scripts: 'junk' };
  const tuloy = testTuloy({ script: { script: [junk, junk, junk, junk] } });
  const { conductor, store, clock, model } = tuloy;
  const start = clock.now();

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('escalated');
  expect(task(tuloy, runId, 'scripts')).toMatchObject({ status: 'escalated', output: null });
  expect(model.calls.filter((c) => c.role === 'script')).toHaveLength(3);
  const recovery = store.events(runId).filter((e) => ['retry', 'escalate', 'end'].includes(e.action));
  expect(recovery.map(({ time, taskId, cause, action, result, data }) => ({ time, taskId, cause, action, result, data }))).toEqual([
    { time: start, taskId: 'scripts', cause: 'invalid_output', action: 'retry', result: 'waiting', data: { do: 'retry', retry: 1, of: 2, waitMs: 2000 } },
    { time: start + 2000, taskId: 'scripts', cause: 'invalid_output', action: 'retry', result: 'waiting', data: { do: 'retry', retry: 2, of: 2, waitMs: 4000 } },
    { time: start + 6000, taskId: 'scripts', cause: '2 of 2 retries used', action: 'escalate', result: 'escalated', data: null },
    { time: start + 6000, taskId: null, cause: 'scripts failed: invalid_output', action: 'end', result: 'escalated', data: null },
  ]);
  // The bad output is never passed on.
  expect(store.events(runId).some((e) => e.taskId === 'review')).toBe(false);
});

test('a task with no answer in the time limit is stalled_timeout, and the retry finishes the run', async () => {
  const tuloy = testTuloy({ script: { script: [hang] } });
  const { conductor, store, clock } = tuloy;
  const start = clock.now();
  const statuses: string[] = [];
  store.subscribe((e) => e.taskId === 'scripts' && statuses.push(`${e.action}: ${task(tuloy, e.runId, 'scripts').status}`));

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  const events = store.events(runId).filter((e) => e.taskId === 'scripts' && e.action !== 'heartbeat');
  expect(events.map((e) => `${e.action} ${e.result}`)).toEqual(['assign script', 'handoff checked content stored', 'dispatch started', 'watch timeout', 'retry waiting', 'dispatch started', 'validate valid', 'review pass']);
  expect(events[3]).toMatchObject({ time: start + 60_000, cause: 'no answer in 60s' });
  expect(events[4]).toMatchObject({ time: start + 60_000, cause: 'timeout', data: { waitMs: 2000 } });
  expect(events[5]).toMatchObject({ time: start + 62_000 });
  // The status when each event was written: stalled during the wait, recovering during the retry.
  expect(statuses.filter((s) => !s.startsWith('heartbeat'))).toEqual([
    'assign: running',
    'handoff: running',
    'dispatch: running',
    'watch: running',
    'retry: stalled_timeout',
    'dispatch: recovering',
    'validate: recovering',
    'review: done',
  ]);
});

test('a slow agent that is alive sends a heartbeat every 5 s until its time limit', async () => {
  const tuloy = testTuloy({ script: { script: [hang] } });
  const start = tuloy.clock.now();

  const { runId, ended } = tuloy.conductor.startRun(SAMPLE_GOAL);
  await ended;

  const heartbeats = tuloy.store.events(runId).filter((e) => e.action === 'heartbeat');
  expect(heartbeats.map((e) => (e.time - start) / 1000)).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  expect(heartbeats[0]).toMatchObject({ taskId: 'scripts', result: 'alive' });
});

test('an injected timeout makes the script agent silent: the missed heartbeat is found, the task is stalled_heartbeat, and the retry finishes the run', async () => {
  const tuloy = testTuloy();
  const { conductor, store, clock, model } = tuloy;
  const start = clock.now();
  store.addInjection('script', 'timeout');
  const statuses: string[] = [];
  store.subscribe((e) => e.action === 'retry' && statuses.push(task(tuloy, e.runId, 'scripts').status));

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  const events = store.events(runId).filter((e) => e.taskId === 'scripts');
  expect(events.map((e) => `${e.action} ${e.result}`)).toEqual([
    'assign script',
    'handoff checked content stored',
    'dispatch started',
    'injection timeout',
    'watch missed_heartbeat',
    'retry waiting',
    'dispatch started',
    'validate valid',
    'review pass',
  ]);
  expect(events[3]).toMatchObject({ cause: 'demo: the presenter injected this failure' });
  expect(events[4]).toMatchObject({ time: start + 20_000, cause: 'no heartbeat for 20s' });
  expect(statuses).toEqual(['stalled_heartbeat']);
  // The silent attempt made no model call, and the injection is used one time only.
  expect(model.calls.filter((c) => c.role === 'script')).toHaveLength(1);
  expect(store.injections()).toEqual([]);
});

test('an injected invalid output at a named task sets failed_validation and is retried; it is never passed on', async () => {
  const tuloy = testTuloy();
  const { conductor, store } = tuloy;
  store.addInjection('trend_scout', 'invalid_output');
  const statuses: string[] = [];
  store.subscribe((e) => e.action === 'retry' && statuses.push(task(tuloy, e.runId, 'trends').status));

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  expect(trail(tuloy, runId, 'trends')).toEqual(['assign trend_scout', 'dispatch started', 'injection invalid_output', 'validate invalid_output', 'retry waiting', 'dispatch started', 'validate valid']);
  expect(statuses).toEqual(['failed_validation']);
  expect(task(tuloy, runId, 'trends').output).toEqual(goodOutput.trend_scout);
});

test('a rate-limit answer from the model is honoured: the retry waits as long as the model asks', async () => {
  const rateLimited = new APICallError({ message: 'Too many requests', url: 'https://model.test/v1', requestBodyValues: {}, statusCode: 429, responseHeaders: { 'retry-after': '7' } });
  const tuloy = testTuloy({ script: { script: [rateLimited] } });
  const { conductor, store, clock } = tuloy;
  const start = clock.now();

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  const events = store.events(runId).filter((e) => e.taskId === 'scripts');
  expect(events.map((e) => `${e.action} ${e.result}`).slice(2, 6)).toEqual(['dispatch started', 'model_call rate_limited', 'retry waiting', 'dispatch started']);
  expect(events[4]).toMatchObject({ cause: 'rate_limited', data: { retry: 1, of: 2, waitMs: 7000 } });
  expect(events[5]).toMatchObject({ time: start + 7000 });
});

test('at most 2 model calls run at the same time', async () => {
  const { conductor, store, model } = testTuloy({ script: { trend_scout: [slow(1000), slow(1000), slow(1000)] } });

  const runs = [conductor.startRun(SAMPLE_GOAL), conductor.startRun(SAMPLE_GOAL), conductor.startRun(SAMPLE_GOAL)];
  await Promise.all(runs.map((r) => r.ended));

  expect(runs.map((r) => store.run(r.runId)?.status)).toEqual(['done', 'done', 'done']);
  expect(model.most.atTheSameTime).toBe(2);
});

test('the limit on model calls at the same time is a setting', async () => {
  const { conductor, model } = testTuloy({ script: { trend_scout: [slow(1000), slow(1000), slow(1000)] }, limits: { maxModelCalls: 3 } });

  await Promise.all([1, 2, 3].map(() => conductor.startRun(SAMPLE_GOAL).ended));

  expect(model.most.atTheSameTime).toBe(3);
});

test('every model call has the limit on output tokens of the settings', async () => {
  const usual = testTuloy();
  await usual.conductor.startRun(SAMPLE_GOAL).ended;
  const small = testTuloy({ limits: { maxOutputTokens: 500 } });
  await small.conductor.startRun(SAMPLE_GOAL).ended;

  expect(usual.model.calls.map((c) => c.maxOutputTokens)).toEqual([2000, 2000, 2000, 2000]);
  expect(small.model.calls.map((c) => c.maxOutputTokens)).toEqual([500, 500, 500, 500]);
});

test('a model error is model_unavailable, and its text is stored without the address that was in it', async () => {
  const noCredits = new Error('This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 2787. To increase, visit https://openrouter.ai/settings/keys/key-id-123 and add credits');
  const tuloy = testTuloy({ script: { script: [noCredits] } });

  const { runId, ended } = tuloy.conductor.startRun(SAMPLE_GOAL);
  await ended;

  const failure = tuloy.store.events(runId).find((e) => e.action === 'model_call')!;
  expect(failure).toMatchObject({
    taskId: 'scripts',
    result: 'model_unavailable',
    cause: 'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 2787. To increase, visit [address removed] and add credits',
  });
  expect(JSON.stringify(tuloy.store.events(runId))).not.toContain('key-id-123');
});

test('a stalled or recovering task has a stuck reason made from its events, and a shown status in plain words', async () => {
  const tuloy = testTuloy();
  const { conductor, store } = tuloy;
  for (let i = 0; i < 3; i++) store.addInjection('script', 'timeout');
  const seen: unknown[] = [];
  const scripts = (runId: number) => {
    const { shownStatus, stuckReason } = taskViews(store.tasks(runId), store.events(runId)).find((t) => t.id === 'scripts')!;
    return [shownStatus, stuckReason];
  };
  store.subscribe((e) => e.taskId === 'scripts' && ['dispatch', 'retry'].includes(e.action) && seen.push(scripts(e.runId)));

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(seen).toEqual([
    ['running', null],
    ['stalled', 'Script task stalled: no heartbeat for 20s. Retry 1 of 2 in 2s.'],
    ['recovering', 'Script task stalled: no heartbeat for 20s. Retry 1 of 2 is running.'],
    ['stalled', 'Script task stalled: no heartbeat for 20s. Retry 2 of 2 in 4s.'],
    ['recovering', 'Script task stalled: no heartbeat for 20s. Retry 2 of 2 is running.'],
  ]);
  expect(taskViews(store.tasks(runId), store.events(runId)).map((t) => [t.id, t.shownStatus, t.stuckReason])).toEqual([
    ['trends', 'done', null],
    ['scripts', 'escalated', 'Script task stalled: no heartbeat for 20s. 2 of 2 retries used. The run ended as escalated.'],
    ['review', 'waiting on dependency', null],
    ['schedule', 'waiting on dependency', null],
  ]);
});

test.each([
  ['a bad output', { script: [{ scripts: 'junk' }] }, 'Script task failed: its output did not match the schema. Retry 1 of 2 in 2s.'],
  ['no answer', { script: [hang] }, 'Script task stalled: no answer in 60s. Retry 1 of 2 in 2s.'],
  ['a rate limit', { script: [new APICallError({ message: 'Too many requests', url: 'https://model.test', requestBodyValues: {}, statusCode: 429 })] }, 'Script task failed: the model is rate-limited. Retry 1 of 2 in 2s.'],
  [
    'a model with no credits',
    { trend_scout: [new Error('This request requires more credits. Visit https://openrouter.ai/settings/keys/key-id-123.')] },
    'Trend scout task failed: the model is not available (This request requires more credits. Visit [address removed]). A model outage is not retried. The run ended as escalated.',
  ],
])('the stuck reason after %s says the cause and what Tuloy did', async (_name, script, reason) => {
  const { conductor, store } = testTuloy({ script });
  const reasons: (string | null)[] = [];
  store.subscribe((e) => ['retry', 'escalate'].includes(e.action) && reasons.push(taskViews(store.tasks(e.runId), store.events(e.runId)).find((t) => t.id === e.taskId)!.stuckReason));

  await conductor.startRun(SAMPLE_GOAL).ended;

  expect(reasons).toEqual([reason]);
});
