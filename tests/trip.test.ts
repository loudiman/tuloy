import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import type { A2aAnswer } from '../src/peer-client.ts';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { createServer } from '../src/server.ts';
import { tripOf } from '../src/trip-view.ts';
import { goodOutput } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

type Tuloy = ReturnType<typeof testTuloy>;
const ids = { taskId: 'a2a-task-1', contextId: 'a2a-context-1' };
const working: A2aAnswer = { status: 'progress', ...ids };
const refused: A2aAnswer = { status: 'refused', text: 'I do not take this work.', ...ids };
const result = (output: unknown): A2aAnswer => ({ status: 'result', text: JSON.stringify(output), ...ids });
const down = () => new Error('503 model down');
const rejection = { reviews: [{ script_id: 's1', verdict: 'reject', score: 3, issues: ['The hook is weak.'], hints: ['Open with a question.'] }, { script_id: 's2', verdict: 'pass', score: 8, issues: [], hints: [] }] };

/** The trip of a run, as the run API gives it. */
const tripAt = ({ store }: Tuloy, runId: number, events = store.events(runId)) => tripOf(store.run(runId)!, [...store.tasks(runId, 1), ...store.tasks(runId)], events);
async function story(tuloy: Tuloy, start = () => tuloy.conductor.startRun(SAMPLE_GOAL)) {
  const { runId, ended } = start();
  await ended;
  const trip = tripAt(tuloy, runId);
  // Each step as one short line: "kind stop lane[ peer] | cargo".
  const lines = trip.steps.map((s) => `${s.kind} ${s.stop ?? '-'} ${s.lane}${s.peer ? ` ${s.peer}` : ''} | ${s.cargo}`);
  return { runId, trip, lines, stops: trip.stops.map((s) => `${s.id} ${s.state} ${s.lane}${s.peer ? ` ${s.peer}` : ''}`) };
}
/** A Tuloy whose primary and backup model are down for the script task, with Maria on the allowed list. */
function ownModelsDown(options: Parameters<typeof testTuloy>[0] = {}) {
  const tuloy = testTuloy({ script: { script: [down()] }, backupScript: { script: [down()] }, ...options });
  tuloy.store.addPeer({ name: 'Maria', address: 'https://maria.example', sendKey: 'the-key-that-maria-accepts', acceptKey: 'the-key-from-maria' });
  return tuloy;
}

const goalOutput = { ...(goodOutput.script as object), ...(goodOutput.scheduler as object) };
const texts = (trip: ReturnType<typeof tripOf>, ...kinds: string[]) => trip.steps.filter((s) => kinds.includes(s.kind)).map((s) => s.text);
const head = ['start - own | Goal', 'work trends own | Goal', 'done trends own | Trends', 'work scripts own | Trends'];
const tail = ['work review own | Scripts', 'done review own | Review', 'pass review own | Review', 'work schedule own | Review', 'done schedule own | Schedule', 'end - own | Schedule'];
const outage = ['failure scripts own | Trends', 'reroute scripts backup | Trends', 'work scripts backup | Trends', 'failure scripts backup | Trends'];
const toMaria = ['reroute scripts peer Maria | Trends', 'work scripts peer Maria | Trends'];

test('a run with no failure: the jeepney goes from stop to stop, and each done step changes what it carries', async () => {
  const { lines, stops, trip } = await story(testTuloy());
  expect(lines).toEqual([...head, 'done scripts own | Scripts', ...tail]);
  expect(stops).toEqual(['trends done own', 'scripts done own', 'review done own', 'schedule done own']);
  expect(trip).toMatchObject({ status: 'done', forPeer: null });
  expect(trip.steps[1]).toMatchObject({ role: 'trend_scout', text: 'The trend scout agent started the trend scout task.', tone: 'ok' });
  expect(texts(trip, 'start', 'end')).toEqual(['The owner gave a goal.', 'The run ended as done.']);
});

test('a failure and a retry at the same stop: the failure has a road sign, and the retry has its number and its wait', async () => {
  const { lines, trip } = await story(testTuloy({ script: { script: [{ scripts: 'junk' }] } }));
  expect(lines).toEqual([...head, 'failure scripts own | Trends', 'retry scripts own | Trends', 'work scripts own | Trends', 'done scripts own | Scripts', ...tail]);
  expect(trip.steps[4]).toMatchObject({ failure: 'invalid_output', sign: 'The output is not valid', tone: 'trouble', text: 'The script agent failed: its output did not match the schema.' });
  expect(trip.steps[4]!.injected).toBeUndefined();
  expect(trip.steps[5]).toMatchObject({ retry: 1, of: 2, waitMs: 2000, tone: 'recovery', text: 'The conductor started the script agent again (retry 1 of 2).' });
});

test('a reviewer rejection: the jeepney goes back to the script stop with the hints, and the review waits for the new script', async () => {
  const tuloy = testTuloy({ script: { reviewer: [rejection] } });
  const seen: string[] = [];
  tuloy.store.subscribe((e) => e.action === 'retry' && seen.push(...tripAt(tuloy, e.runId).stops.map((s) => `${s.id} ${s.state}`)));
  const { lines, trip } = await story(tuloy);
  const again = ['work scripts own | Hints', 'done scripts own | Scripts'];
  expect(lines).toEqual([...head, 'done scripts own | Scripts', ...tail.slice(0, 2), 'rejection scripts own | Hints', 'retry scripts own | Hints', ...again, ...tail]);
  expect(trip.steps.find((s) => s.kind === 'rejection')).toMatchObject({ role: 'script', sign: 'Rejected by the reviewer', text: 'The reviewer rejected s1.' });
  expect(seen).toEqual(['trends done', 'scripts rejected', 'review waiting', 'schedule waiting']);
});

test('a re-route to the backup model: the script stop is in the backup lane from the re-route on', async () => {
  const { lines, stops } = await story(testTuloy({ script: { script: [down()] }, backupScript: {} }));
  expect(lines).toEqual([...head, ...outage.slice(0, 3), 'done scripts backup | Scripts', ...tail]);
  expect(stops[1]).toBe('scripts done backup');
});

test("a re-route to a peer's agent: the steps name the peer, and a heartbeat is not a step", async () => {
  const tuloy = ownModelsDown({ peer: [working, working, result(goodOutput.script)] });
  const beats: (number | null)[] = [];
  tuloy.store.subscribe((e) => e.action === 'heartbeat' && e.taskId === 'scripts' && beats.push(tripAt(tuloy, e.runId).stops[1]!.lastHeartbeat));
  const { lines, stops, trip, runId } = await story(tuloy);
  expect(lines).toEqual([...head, ...outage, ...toMaria, 'done scripts peer Maria | Scripts', ...tail]);
  expect(stops[1]).toBe('scripts done peer Maria');
  expect(texts(trip, 'reroute')).toEqual(['The conductor re-routed the script task to the backup model.', "The conductor re-routed the script task to Maria's script agent."]);
  // The stop that works has the time of its last heartbeat; a stop that is done has none.
  expect(beats).toEqual(tuloy.store.events(runId).filter((e) => e.action === 'heartbeat' && e.taskId === 'scripts').map((e) => e.time));
  expect(beats.length).toBeGreaterThan(0);
  expect(trip.stops[1]!.lastHeartbeat).toBeNull();
});

test("a peer's script that the reviewer rejects goes to the same peer one more time", async () => {
  const { lines, trip } = await story(ownModelsDown({ peer: [result(goodOutput.script)], script: { script: [down()], reviewer: [rejection] } }));
  const again = ['rejection scripts peer Maria | Hints', 'reroute scripts peer Maria | Hints', 'work scripts peer Maria | Hints', 'done scripts peer Maria | Scripts'];
  expect(lines).toEqual([...head, ...outage, ...toMaria, 'done scripts peer Maria | Scripts', ...tail.slice(0, 2), ...again, ...tail]);
  expect(texts(trip, 'failure', 'reroute', 'rejection', 'pass', 'end')).toEqual([
    'The script agent failed: the model is not available (503 model down).',
    'The conductor re-routed the script task to the backup model.',
    'The backup model failed also.',
    "The conductor re-routed the script task to Maria's script agent.",
    'The reviewer rejected s1.',
    "The conductor re-routed the script task to Maria's script agent.",
    'The reviewer passed every script.',
    'The run ended as done.',
  ]);
});

test('the full goal at a peer: one more stop in the lane of the peer\'s conductor, and the stops of the first task graph stay', async () => {
  const tuloy = ownModelsDown({ peer: [refused, working, working, result(goalOutput)] });
  const { lines, stops, trip, runId } = await story(tuloy);
  expect(lines).toEqual([
    ...head,
    ...outage,
    ...toMaria,
    'failure scripts peer Maria | Trends',
    'goal_to_peer goal peer_goal Maria | Goal',
    'work goal peer_goal Maria | Goal',
    'done goal peer_goal Maria | Scripts and schedule',
    'end - own | Scripts and schedule',
  ]);
  expect(stops).toEqual(['trends done own', 'scripts blocked peer Maria', 'review waiting own', 'schedule waiting own', 'goal done peer_goal Maria']);
  expect(texts(trip, 'goal_to_peer', 'work', 'done').slice(-3)).toEqual(['The conductor gave the full goal to Maria.', "Maria's conductor started the goal task.", "Maria's conductor finished the goal task."]);
  expect(trip.steps.find((s) => s.kind === 'goal_to_peer')).toMatchObject({ role: 'goal', tone: 'recovery' });

  // The run API gives the same trip.
  const server = createServer({ store: tuloy.store, conductor: tuloy.conductor, owner: 'Lou', demo: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs/${runId}`)).json()) as { trip: unknown; recovery: unknown[] };
    expect(body.trip).toEqual(JSON.parse(JSON.stringify(trip)));
    expect(body.recovery.length).toBeGreaterThan(0);
  } finally {
    server.close();
  }
});

test('an escalated run: the last step gives the plain cause, and the stop stays blocked', async () => {
  const { lines, stops, trip } = await story(testTuloy({ script: { script: [down()] } }));
  expect(lines).toEqual([...head, ...outage, 'end - own | Trends']);
  expect(stops).toEqual(['trends done own', 'scripts blocked backup', 'review waiting own', 'schedule waiting own']);
  expect(trip.status).toBe('escalated');
  expect(trip.steps.at(-1)).toMatchObject({ tone: 'end', text: 'The run ended as escalated: the backup model also failed.' });
});

test('an injected failure is marked, so that it is never read as a real one', async () => {
  const tuloy = ownModelsDown({ peer: [result(goodOutput.script)], script: {}, backupScript: {} });
  tuloy.store.addInjection('script', 'all_models_outage');
  const { trip } = await story(tuloy);
  expect(trip.steps.filter((s) => s.kind === 'injection' || s.kind === 'failure').map((s) => `${s.kind} ${s.lane} ${s.injected ?? false}`)).toEqual(['injection own false', 'failure own true', 'failure backup true']);
  expect(texts(trip, 'injection')).toEqual(['Demo: the presenter injected a failure of the script agent (all models outage).']);
});

test('work for a peer: the trip names the owner that sent it; one task is one stop, and a full goal is the four stops', async () => {
  const one = testTuloy();
  const task = await story(one, () => one.conductor.startPeerTask('Lou', 'script', { goal: SAMPLE_GOAL, ...(goodOutput.trend_scout as object) }));
  expect(task.trip.forPeer).toBe('Lou');
  expect(task.lines).toEqual(['start scripts own | Trends', 'work scripts own | Trends', 'done scripts own | Scripts', 'end - own | Scripts']);
  expect(task.stops).toEqual(['scripts done own']);
  expect(task.trip.steps[0]!.text).toBe('Lou sent a task for the script agent.');

  const all = testTuloy();
  const goal = await story(all, () => all.conductor.startRun(SAMPLE_GOAL, 'Lou'));
  expect(goal.trip.forPeer).toBe('Lou');
  expect(goal.lines).toEqual([...head, 'done scripts own | Scripts', ...tail]);
  expect(goal.trip.steps[0]!.text).toBe('Lou gave a full goal.');
});

test('more events only add steps: the steps of a part of the events are the start of the steps of all the events', async () => {
  const tuloy = ownModelsDown({ peer: [result(goodOutput.script), result(goodOutput.script), refused, working, result(goalOutput)], script: { script: [down()], reviewer: [rejection, rejection] } });
  const { runId, trip } = await story(tuloy);
  expect(trip.steps.some((s) => s.kind === 'rejection') && trip.steps.some((s) => s.kind === 'goal_to_peer')).toBe(true);
  const events = tuloy.store.events(runId);
  for (let cut = 0; cut <= events.length; cut++) {
    const part = tripAt(tuloy, runId, events.slice(0, cut)).steps;
    expect(part).toEqual(trip.steps.slice(0, part.length));
  }
});
