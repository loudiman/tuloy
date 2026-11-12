import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { createServer } from '../src/server.ts';
import { readSettings } from '../src/settings.ts';
import { testTuloy } from './harness/tuloy.ts';

/** One Tuloy with its HTTP server on a free port. `call` sends JSON and returns the status and the JSON answer. */
async function withServer(demo: boolean, test: (call: (method: string, path: string, body?: unknown) => Promise<[number, any]>, tuloy: ReturnType<typeof testTuloy>) => Promise<void>) {
  const tuloy = testTuloy({ demo });
  const server = createServer({ store: tuloy.store, conductor: tuloy.conductor, owner: 'Lou', demo });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await test(async (method, path, body) => {
      const response = await fetch(url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      return [response.status, await response.json().catch(() => null)];
    }, tuloy);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

/** Asks for the run until it has ended. The test clock makes the waits of the run take no real time. */
async function endedRun(call: (method: string, path: string) => Promise<[number, any]>, runId: number) {
  for (;;) {
    const [, state] = await call('GET', `/api/runs/${runId}`);
    if (state.run.status !== 'running') return state;
  }
}

test('demo mode is the setting TULOY_DEMO=1', () => {
  expect([readSettings({}).demo, readSettings({ TULOY_DEMO: '1' }).demo, readSettings({ TULOY_DEMO: '0' }).demo]).toEqual([false, true, false]);
});

test('in demo mode the presenter injects a timeout at the script task by default, sees it pending, and the run recovers', async () => {
  await withServer(true, async (call) => {
    expect(await call('POST', '/api/injections', { kind: 'timeout' })).toEqual([201, { id: 1, task: 'script', kind: 'timeout' }]);
    expect(await call('GET', '/api/injections')).toEqual([200, { demo: true, injections: [{ id: 1, task: 'script', kind: 'timeout' }] }]);

    const [, { runId }] = await call('POST', '/api/runs');
    const state = await endedRun(call, runId);

    expect(state.run.status).toBe('done');
    expect(state.events.filter((e: any) => ['injection', 'watch', 'retry'].includes(e.action)).map((e: any) => `${e.taskId} ${e.action} ${e.result}`)).toEqual([
      'scripts injection timeout',
      'scripts watch missed_heartbeat',
      'scripts retry waiting',
    ]);
    expect(state.tasks.map((t: any) => [t.id, t.shownStatus, t.stuckReason])).toEqual([
      ['trends', 'done', null],
      ['scripts', 'done', null],
      ['review', 'done', null],
      ['schedule', 'done', null],
    ]);
    expect(await call('GET', '/api/injections')).toEqual([200, { demo: true, injections: [] }]);
  });
});

test('when all own models are down, the run API shows the run as escalated with the stuck reason of the task', async () => {
  await withServer(true, async (call) => {
    await call('POST', '/api/injections', { task: 'trend_scout', kind: 'all_models_outage' });

    const [, { runId }] = await call('POST', '/api/runs');
    const state = await endedRun(call, runId);

    expect(state.run.status).toBe('escalated');
    expect(state.tasks[0]).toMatchObject({
      id: 'trends',
      status: 'escalated',
      shownStatus: 'escalated',
      stuckReason: 'Trend scout task failed: the model is not available (demo: injected outage of all own models). The backup model also failed. The run ended as escalated.',
    });
    expect(state.tasks[1]).toMatchObject({ id: 'scripts', shownStatus: 'waiting on dependency', stuckReason: null });
  });
});

test.each([
  ['a kind that does not exist', { task: 'script', kind: 'meteor' }],
  ['no kind', {}],
  ['a task that is not an agent role', { task: 'janitor', kind: 'timeout' }],
  ['a body that is not JSON', undefined],
])('an injection with %s is refused with 400', async (_name, body) => {
  await withServer(true, async (call) => {
    const [status, answer] = await call('POST', '/api/injections', body);

    expect(status).toBe(400);
    expect(answer.error).toEqual(expect.any(String));
    expect(await call('GET', '/api/injections')).toEqual([200, { demo: true, injections: [] }]);
  });
});

test('outside demo mode there is no injection', async () => {
  await withServer(false, async (call, { store }) => {
    expect((await call('POST', '/api/injections', { kind: 'timeout' }))[0]).toBe(404);
    expect((await call('GET', '/api/injections'))[0]).toBe(404);
    expect(store.injections()).toEqual([]);
  });
});

// ---- Review fix 3: injections act only in demo mode and only on the owner's own runs; the owner can clear them ----

test('an injection that is left in the data file does nothing when demo mode is off, and it is not used up', async () => {
  const { store, conductor } = testTuloy({ demo: false });
  store.addInjection('script', 'all_models_outage');

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  expect(store.events(runId).filter((e) => e.action === 'injection')).toEqual([]);
  expect(store.injections()).toHaveLength(1);
});

test('an injection never acts on a run for a peer: it waits for a run of the owner', async () => {
  const { store, conductor } = testTuloy();
  store.addInjection('trend_scout', 'timeout');

  const forPeer = conductor.startPeerTask('Lou', 'trend_scout', { goal: SAMPLE_GOAL });
  await forPeer.ended;
  const goalForPeer = conductor.startRun(SAMPLE_GOAL, 'Lou');
  await goalForPeer.ended;

  for (const { runId } of [forPeer, goalForPeer]) {
    expect(store.run(runId)?.status).toBe('done');
    expect(store.events(runId).filter((e) => ['injection', 'watch', 'retry'].includes(e.action))).toEqual([]);
  }
  expect(store.injections()).toHaveLength(1);

  const own = conductor.startRun(SAMPLE_GOAL);
  await own.ended;
  expect(store.events(own.runId).filter((e) => e.action === 'injection').map((e) => `${e.taskId} ${e.result}`)).toEqual(['trends timeout']);
  expect(store.injections()).toEqual([]);
});

test('the owner clears the pending injections; after that none is shown and none acts', async () => {
  await withServer(true, async (call, { store }) => {
    await call('POST', '/api/injections', { kind: 'timeout' });
    await call('POST', '/api/injections', { task: 'goal', kind: 'peer_silent' });

    expect((await call('DELETE', '/api/injections'))[0]).toBe(204);

    expect(await call('GET', '/api/injections')).toEqual([200, { demo: true, injections: [] }]);
    const [, { runId }] = await call('POST', '/api/runs');
    const state = await endedRun(call, runId);
    expect(state.events.filter((e: any) => e.action === 'injection')).toEqual([]);
    expect(store.injections()).toEqual([]);
  });
  await withServer(false, async (call) => expect((await call('DELETE', '/api/injections'))[0]).toBe(404));
});

test('the page has a control that clears the pending injections', async () => {
  const { readFileSync } = await import('node:fs');
  expect(readFileSync(new URL('../src/page/index.html', import.meta.url), 'utf8')).toContain('id="demo-clear"');
});
