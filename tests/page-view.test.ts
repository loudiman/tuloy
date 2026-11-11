import { expect, test } from 'vitest';
import { headerOf, shownStatus, timelineOf } from '../src/page/view.ts';

test('the status of a task is one of the seven plain words', () => {
  const word = (status: string, runStatus = 'running') => shownStatus({ status }, runStatus);

  expect(word('queued')).toBe('queued');
  expect(word('waiting_on_dependency')).toBe('waiting on dependency');
  expect(word('running')).toBe('running');
  expect(word('stalled_timeout')).toBe('stalled');
  expect(word('stalled_heartbeat')).toBe('stalled');
  expect(word('failed_validation')).toBe('recovering');
  expect(word('rejected')).toBe('recovering');
  expect(word('model_unavailable')).toBe('recovering');
  expect(word('recovering')).toBe('recovering');
  expect(word('done')).toBe('done');
  expect(word('escalated')).toBe('escalated');
});

test('the status word that the server sends wins over the stored status', () => {
  expect(shownStatus({ status: 'running', shownStatus: 'recovering' }, 'running')).toBe('recovering');
});

test('in an escalated run, the task that could not finish is escalated, and a task that never started keeps its word', () => {
  expect(shownStatus({ status: 'rejected' }, 'escalated')).toBe('escalated');
  expect(shownStatus({ status: 'model_unavailable' }, 'escalated')).toBe('escalated');
  expect(shownStatus({ status: 'waiting_on_dependency' }, 'escalated')).toBe('waiting on dependency');
  expect(shownStatus({ status: 'done' }, 'escalated')).toBe('done');
});

test('a status word that the page does not know is shown as it is, with spaces', () => {
  expect(shownStatus({ status: 'sent_to_peer' }, 'running')).toBe('sent to peer');
});

const startedAt = Date.parse('2026-11-12T09:00:00+08:00');
const task = (id: string, status: string, more: object = {}) => ({ id, title: `Task ${id}`, role: 'script', agent: null, dependsOn: [], output: null, status, ...more });

test('the header of a running run: start in Manila time, time passed until now, tasks done of total, no stuck task', () => {
  const run = { id: 1, goal: 'A goal', status: 'running', startedAt, endedAt: null };
  const tasks = [task('a', 'done'), task('b', 'running'), task('c', 'waiting_on_dependency')];

  expect(headerOf(run, tasks, startedAt + 75_000)).toEqual({ started: '12 Nov 2026, 09:00:00', passed: '00:01:15', done: 1, total: 3, stuck: null });
});

test('the header of an ended run: the time passed stops at the end of the run', () => {
  const run = { id: 1, goal: 'A goal', status: 'done', startedAt, endedAt: startedAt + 3_725_000 };

  expect(headerOf(run, [task('a', 'done')], startedAt + 99_999_999)).toMatchObject({ passed: '01:02:05', done: 1, total: 1 });
});

test('the header names the task that is stuck now: stalled, recovering, or the one where an escalated run stopped', () => {
  const running = { id: 1, goal: 'A goal', status: 'running', startedAt, endedAt: null };
  const escalated = { ...running, status: 'escalated', endedAt: startedAt + 1000 };

  expect(headerOf(running, [task('a', 'done'), task('b', 'stalled_timeout'), task('c', 'queued')], startedAt).stuck?.id).toBe('b');
  expect(headerOf(running, [task('a', 'running', { shownStatus: 'recovering' })], startedAt).stuck?.id).toBe('a');
  expect(headerOf(escalated, [task('a', 'done'), task('b', 'rejected'), task('c', 'waiting_on_dependency')], startedAt).stuck?.id).toBe('b');
  expect(headerOf({ ...running, status: 'done' }, [task('a', 'done')], startedAt).stuck).toBeNull();
});

const event = (seq: number, taskId: string | null, action: string, result: string, cause: string, data: unknown = null) => ({
  seq,
  time: startedAt + seq * 1000,
  runId: 1,
  taskId,
  action,
  result,
  cause,
  data,
});

test('the timeline of a task has its events in order, each with a time in Manila time, a title, the result and the cause', () => {
  const events = [
    event(1, null, 'plan', 'planned', 'The conductor made the task graph.'),
    event(2, 'scripts', 'handoff', 'accepted', 'The checked output of trends is the input.', { from: 'trends', content: { goal: 'A goal' } }),
    event(3, 'review', 'dispatch', 'started', 'All dependencies are done.'),
    event(4, 'scripts', 'validate', 'invalid_output', 'The output did not match the schema.'),
  ];

  expect(timelineOf(events, 'scripts')).toEqual([
    { seq: 2, taskId: 'scripts', time: '09:00:02', title: 'Handoff', result: 'accepted', cause: 'The checked output of trends is the input.', kind: 'handoff', data: { from: 'trends', content: { goal: 'A goal' } } },
    { seq: 4, taskId: 'scripts', time: '09:00:04', title: 'Output check', result: 'invalid output', cause: 'The output did not match the schema.', kind: 'trouble', data: null },
  ]);
});

test('an event action that the page does not know is a plain timeline row: action, result, cause, time', () => {
  const rows = timelineOf([event(7, 'scripts', 'goal_to_peer', 'sent', 'Own models and the peer agent failed.')], 'scripts');

  expect(rows).toEqual([{ seq: 7, taskId: 'scripts', time: '09:00:07', title: 'Goal to peer', result: 'sent', cause: 'Own models and the peer agent failed.', kind: 'recovery', data: null }]);
});

test('retries and re-routes are marked as recovery actions; the whole run shows every event', () => {
  const events = [
    event(1, null, 'plan', 'planned', 'c'),
    event(2, 'scripts', 'retry', 'scheduled', 'c'),
    event(3, 'scripts', 'reroute', 'backup_model', 'c'),
    event(4, 'scripts', 'model_switch', 'backup', 'c'),
    event(5, null, 'end', 'escalated', 'c'),
  ];

  expect(timelineOf(events, null).map((r) => [r.title, r.kind])).toEqual([
    ['Task graph made', 'plain'],
    ['Retry', 'recovery'],
    ['Reroute', 'recovery'],
    ['Model switch', 'recovery'],
    ['Run ended', 'trouble'],
  ]);
});

test('a run that ended as escalated has no stalled task: the server word stalled, recovering or running shows as escalated', () => {
  expect(shownStatus({ status: 'rejected', shownStatus: 'stalled' }, 'escalated')).toBe('escalated');
  expect(shownStatus({ status: 'recovering', shownStatus: 'recovering' }, 'escalated')).toBe('escalated');
  expect(shownStatus({ status: 'done', shownStatus: 'done' }, 'escalated')).toBe('done');
  expect(shownStatus({ status: 'rejected', shownStatus: 'stalled' }, 'running')).toBe('stalled');
});
