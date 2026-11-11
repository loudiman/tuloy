import { APICallError } from 'ai';
import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { goodOutput, hang } from './harness/scripted-model.ts';
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
