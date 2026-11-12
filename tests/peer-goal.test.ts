import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createPeerClient, type A2aAnswer } from '../src/peer-client.ts';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { createServer } from '../src/server.ts';
import { readSettings } from '../src/settings.ts';
import { nextAction, type Failure } from '../src/recovery-policy.ts';
import type { TuloyEvent } from '../src/store.ts';
import { taskViews } from '../src/task-view.ts';
import { goodOutput } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

const limits = { retries: 2, retryWaitMs: 2000 };
const fail = (kind: Failure['kind'], where: Partial<Failure> = {}): Failure => ({ kind, detail: 'x', ...where });
const earlier = [fail('model_unavailable'), fail('model_unavailable', { onBackup: true })];
const goal = { do: 'goal', cause: 'the re-route to a peer failed' };
const escalate = (cause: string) => ({ do: 'escalate', cause });
const own = { forPeer: false, peers: 1 };

// Step 4 of the recovery order: (failure, the earlier failures of this task, whose work it is) → next action
test.each([
  ['a peer that refuses or fails: the full goal goes to a peer', fail('peer_failed', { onPeer: true }), earlier, own, goal],
  ['a silent peer: the full goal goes to a peer', fail('timeout', { onPeer: true }), earlier, own, goal],
  ['a bad payload from a peer: the full goal goes to a peer', fail('invalid_output', { onPeer: true }), earlier, own, goal],
  ['the full goal is given one time: when that fails, the run is escalated', fail('peer_failed', { onPeer: true, onGoal: true }), [], own, escalate('every path failed')],
  ['a goal that came from a peer is never given to another peer', fail('peer_failed', { onPeer: true }), earlier, { forPeer: true, peers: 1 }, escalate('the re-route to a peer failed')],
  ['with an empty allowed list the goal step has nobody to ask', fail('peer_failed', { onPeer: true }), earlier, { forPeer: false, peers: 0 }, escalate('the re-route to a peer failed')],
] as const)('%s', (_name, failure, history, work, action) => {
  expect(nextAction(failure, [...history], limits, work)).toEqual(action);
});

// Step 4 through the conductor, with the scripted fake peer client.

type Tuloy = ReturnType<typeof testTuloy>;
const KEY = 'the-key-that-maria-accepts-from-this-tuloy';
const ids = { taskId: 'a2a-task-1', contextId: 'a2a-context-1' };
const working: A2aAnswer = { status: 'progress', ...ids };
const refused: A2aAnswer = { status: 'refused', text: 'I do not take this work.', ...ids };
const result = (output: unknown): A2aAnswer => ({ status: 'result', text: JSON.stringify(output), ...ids });
const down = () => new Error('503 model down');
/** What a peer returns for a full goal: the scripts and the posting schedule. */
const goalOutput = { ...(goodOutput.script as object), ...(goodOutput.scheduler as object) };
const lines = ({ store }: Tuloy, runId: number, pick: (e: TuloyEvent) => boolean) => store.events(runId).filter(pick).map((e) => `${e.action} ${e.result}`);
const goalTask = ({ store }: Tuloy, runId: number) => taskViews(store.tasks(runId), store.events(runId))[0]!;
const sends = ({ peer }: Tuloy) => peer.calls.filter((c) => c.move === 'send').map((c) => JSON.parse((c.call as unknown as { text: string }).text));

/** A Tuloy whose primary and backup model are down for the script task, with Maria on the allowed list. */
function ownModelsDown(options: Parameters<typeof testTuloy>[0] = {}) {
  const tuloy = testTuloy({ script: { script: [down()] }, backupScript: { script: [down()] }, ...options });
  tuloy.store.addPeer({ name: 'Maria', address: 'https://maria.example', sendKey: KEY, acceptKey: 'the-key-from-maria' });
  return tuloy;
}

test("own models down and the peer's agent refuses: the full goal goes to the peer, as a new task graph version with one task, and the run ends as done", async () => {
  const tuloy = ownModelsDown({ peer: [refused, working, result({ ...goalOutput, extra: 'dropped' })] });
  const { conductor, store } = tuloy;

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  // The task graph of the run is now its second version: one task, done by the peer's conductor, with the checked scripts and schedule.
  expect(store.tasks(runId)).toMatchObject([{ id: 'goal', title: 'Give the full goal to Maria', dependsOn: [], role: 'goal', status: 'done', agent: "Maria's conductor" }]);
  expect(store.tasks(runId)[0]!.output).toEqual(goalOutput);
  // The step is in the event log: on the task that failed, then on the run, then the trail of the new task.
  expect(lines(tuloy, runId, (e) => ['plan', 'goal_to_peer', 'end'].includes(e.action))).toEqual(['plan task graph stored: 4 tasks', 'goal_to_peer Maria', 'plan task graph version 2 stored: 1 task', 'end done']);
  expect(store.events(runId).find((e) => e.action === 'goal_to_peer')).toMatchObject({
    taskId: 'scripts',
    cause: 'the re-route to a peer failed',
    data: { do: 'goal', peer: 'Maria', tried: ['the own script agent', 'the backup model', "Maria's script agent"] },
  });
  expect(lines(tuloy, runId, (e) => e.taskId === 'goal')).toEqual(["assign Maria's conductor", 'dispatch started', 'validate valid']);
  // The peer got the task first, then the full goal, one time.
  expect(sends(tuloy)).toEqual([{ skill: 'script', input: expect.objectContaining({ goal: SAMPLE_GOAL }) }, { skill: 'goal', input: { goal: SAMPLE_GOAL } }]);
  expect(JSON.stringify(store.events(runId))).not.toContain(KEY);
});

test.each<[string, A2aAnswer[], string]>([
  ['refuses the goal too', [refused], 'Full goal task failed: Maria refused the task: I do not take this work.'],
  ['fails the goal', [refused, working, { status: 'failed', failure: 'agent-failed', text: "Maria's Tuloy did not finish the goal: the run ended as escalated.", ...ids }], "Full goal task failed: Maria's conductor failed: Maria's Tuloy did not finish the goal: the run ended as escalated."],
  ['returns scripts with no schedule', [refused, result(goodOutput.script)], 'Full goal task failed: its output did not match the schema.'],
])('a peer that %s: the goal is given one time, and the run ends as escalated with a stuck reason that names every path', async (_name, answers, whatFailed) => {
  const tuloy = ownModelsDown({ peer: answers });
  const { conductor, store } = tuloy;

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('escalated');
  expect(goalTask(tuloy, runId)).toMatchObject({
    id: 'goal',
    status: 'escalated',
    output: null,
    stuckReason: `${whatFailed} Every path failed: the own script agent, the backup model, Maria's script agent, the full goal to Maria. The run ended as escalated.`,
  });
  expect(sends(tuloy).map((s) => s.skill)).toEqual(['script', 'goal']);
  expect(lines(tuloy, runId, (e) => e.action === 'goal_to_peer' || e.action === 'end')).toEqual(['goal_to_peer Maria', 'end escalated']);
});

test('the retries that were used are one of the paths in the stuck reason', async () => {
  const junk = { scripts: 'junk' };
  const tuloy = ownModelsDown({ script: { script: [junk, junk, junk] }, backupScript: { script: [junk] }, peer: [refused] });

  const { runId, ended } = tuloy.conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(goalTask(tuloy, runId).stuckReason).toBe(
    "Full goal task failed: Maria refused the task: I do not take this work. Every path failed: the own script agent, 2 retries, the backup model, Maria's script agent, the full goal to Maria. The run ended as escalated.",
  );
});

test("a script from a peer that the own reviewer rejects two times: the full goal goes to the peer, and the cause says why", async () => {
  const rejected = { reviews: [{ script_id: 's1', verdict: 'reject', score: 3, issues: ['The hook does not name the store.'], hints: ['Name the store.'] }, { script_id: 's2', verdict: 'pass', score: 8, issues: [], hints: [] }] };
  const tuloy = ownModelsDown({ script: { script: [down()], reviewer: [rejected, rejected] }, peer: [result(goodOutput.script), result(goodOutput.script), result(goalOutput)] });
  const { conductor, store } = tuloy;

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  expect(store.tasks(runId)).toMatchObject([{ id: 'goal', status: 'done', output: goalOutput }]);
  expect(lines(tuloy, runId, (e) => e.taskId === 'scripts' && ['reroute', 'review', 'goal_to_peer'].includes(e.action))).toEqual([
    'reroute backup model',
    "reroute Maria's script agent",
    'review rejected',
    "reroute Maria's script agent",
    'review rejected',
    'goal_to_peer Maria',
  ]);
  // The peer wrote the script two times. That is one path, and the cause is the rejection, not a failed re-route.
  expect(store.events(runId).find((e) => e.action === 'goal_to_peer')).toMatchObject({
    cause: "the reviewer rejected the peer's script again",
    data: { tried: ['the own script agent', 'the backup model', "Maria's script agent"] },
  });
  expect(sends(tuloy).map((s) => s.skill)).toEqual(['script', 'script', 'goal']);
});

test('with no peer on the allowed list the goal is given to nobody, and the run ends as escalated as before', async () => {
  const tuloy = testTuloy({ script: { script: [down()] } });

  const { runId, ended } = tuloy.conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(tuloy.store.run(runId)?.status).toBe('escalated');
  expect(tuloy.store.tasks(runId)).toHaveLength(4);
  expect(lines(tuloy, runId, (e) => e.action === 'goal_to_peer')).toEqual([]);
});

// The serving side and the full path, with real Tuloys on free ports of this machine: the scripted model, the real peer client.

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function startTuloy(owner: string, options: Parameters<typeof testTuloy>[0] = {}) {
  const tuloy = testTuloy({ ...options, peerClient: createPeerClient({ allowLocal: true }) });
  const server = createServer({ store: tuloy.store, conductor: tuloy.conductor, owner, peerAllowLocal: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stops.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { ...tuloy, owner, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
type Started = Awaited<ReturnType<typeof startTuloy>>;

/** `a` makes an invite and `b` accepts it: each is on the allowed list of the other. */
async function invite(a: Started, b: Started) {
  const { link } = (await (await fetch(`${a.url}/api/invites`, { method: 'POST' })).json()) as { link: string };
  expect((await fetch(`${b.url}/api/invites/accept`, { method: 'POST', body: JSON.stringify({ link }) })).status).toBe(201);
}

/** `from` sends the full goal to `to` over A2A, as its conductor does, and reads the A2A task until it has ended. */
async function sendGoal(from: Started, to: Started) {
  const client = createPeerClient({ allowLocal: true });
  const call = { address: `${to.url}/a2a`, key: from.store.peers().find((p) => p.name === to.owner)!.sendKey };
  const first = await client.send({ ...call, callId: randomUUID(), text: JSON.stringify({ skill: 'goal', input: { goal: SAMPLE_GOAL } }) });
  let last = first;
  while (last.status === 'progress') last = await client.read({ ...call, taskId: last.taskId! });
  return { first, last };
}

test('the agent card lists a skill for a full goal; a goal sent with it starts a run on the peer, and the A2A task follows that run to its scripts and schedule', async () => {
  const sam = await startTuloy('Sam');
  const lou = await startTuloy('Lou');
  await invite(sam, lou);

  const card = (await (await fetch(`${lou.url}/.well-known/agent-card.json`)).json()) as { skills: { id: string; name: string }[] };
  expect(card.skills.map((s) => s.id)).toEqual(['trend_scout', 'script', 'reviewer', 'scheduler', 'goal']);
  expect(card.skills.at(-1)).toMatchObject({ name: 'full goal' });

  const { first, last } = await sendGoal(sam, lou);

  expect(first.status).toBe('progress');
  expect(last).toMatchObject({ status: 'result' });
  expect(JSON.parse((last as { text: string }).text)).toEqual(goalOutput);
  // Lou's Tuloy did a full run for Sam.
  const [run] = lou.store.runs();
  expect(run).toMatchObject({ goal: SAMPLE_GOAL, forPeer: 'Sam', status: 'done' });
  expect(lou.store.tasks(run!.id).map((t) => `${t.id} ${t.status}`)).toEqual(['trends done', 'scripts done', 'review done', 'schedule done']);
  expect(lou.store.events(run!.id)[0]).toMatchObject({ action: 'plan', cause: 'Sam gave a full goal', result: 'task graph stored: 4 tasks' });
});

test('a peer run that ends as escalated returns failed, and a goal that came from a peer is never given to another peer', async () => {
  // Lou's own models are down for the script task. Lou has two peers: Sam, who gives the goal, and Ana.
  const sam = await startTuloy('Sam');
  const lou = await startTuloy('Lou', { script: { script: [down()] } });
  const ana = await startTuloy('Ana');
  await invite(sam, lou);
  await invite(lou, ana);

  const { last } = await sendGoal(sam, lou);

  expect(last).toMatchObject({ status: 'failed', text: "Lou's Tuloy did not finish the goal: the run ended as escalated." });
  const [run] = lou.store.runs();
  expect(run).toMatchObject({ forPeer: 'Sam', status: 'escalated' });
  expect(lines(lou, run!.id, (e) => e.taskId === 'scripts').slice(-3)).toEqual(['dispatch started', 'model_call model_unavailable', 'escalate escalated']);
  expect(lines(lou, run!.id, (e) => e.action === 'goal_to_peer' || (e.action === 'reroute' && e.result !== 'backup model'))).toEqual([]);
  expect(ana.store.runs()).toEqual([]);
  expect(sam.store.runs()).toEqual([]);
});

test("two real Tuloys: own models down and the peer's agent refuses → the peer finishes the goal", async () => {
  // Sam's two models are down for the script task. Lou's script agent refuses (the demo injection); then Lou takes the full goal.
  const sam = await startTuloy('Sam', { script: { script: [down()] } });
  const lou = await startTuloy('Lou');
  await invite(sam, lou);
  sam.store.addInjection('script', 'peer_refuses');

  const { runId, ended } = sam.conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(sam.store.run(runId)?.status).toBe('done');
  expect(lines(sam, runId, (e) => e.taskId === 'scripts')).toEqual([
    'assign script',
    'handoff checked content stored',
    'dispatch started',
    'model_call model_unavailable',
    'reroute backup model',
    'dispatch started',
    'model_call model_unavailable',
    "reroute Lou's script agent",
    'dispatch started',
    'injection peer_refuses',
    'peer_call peer_failed',
    'goal_to_peer Lou',
  ]);
  // Sam's task graph is now one task, and its output is the scripts and the schedule that Lou's run made.
  expect(goalTask(sam, runId)).toMatchObject({ id: 'goal', status: 'done', shownStatus: 'done', agent: "Lou's conductor", output: goalOutput, stuckReason: null });
  // Lou did one full run for Sam, with its own four agents. Sam's own agents made nothing after the trends.
  expect(lou.store.runs()).toMatchObject([{ goal: SAMPLE_GOAL, forPeer: 'Sam', status: 'done' }]);
  expect(lou.model.calls.map((c) => c.role)).toEqual(['trend_scout', 'script', 'reviewer', 'scheduler']);
  expect(sam.model.calls.map((c) => c.role)).toEqual(['trend_scout', 'script']);
  const { sendKey } = sam.store.peers()[0]!;
  expect(JSON.stringify([sam.store.events(runId), lou.store.events(lou.store.runs()[0]!.id)])).not.toContain(sendKey);
});

test('two real Tuloys: the peer fails the task and then fails the goal → the run ends as escalated, and the goal was given one time', async () => {
  const sam = await startTuloy('Sam', { script: { script: [down()] } });
  const lou = await startTuloy('Lou', { script: { script: [down(), down()] } });
  await invite(sam, lou);

  const { runId, ended } = sam.conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(sam.store.run(runId)?.status).toBe('escalated');
  expect(goalTask(sam, runId).stuckReason).toBe(
    "Full goal task failed: Lou's conductor failed: Lou's Tuloy did not finish the goal: the run ended as escalated. Every path failed: the own script agent, the backup model, Lou's script agent, the full goal to Lou. The run ended as escalated.",
  );
  // Lou has two runs for Sam: the script task, then the full goal. No third.
  expect(lou.store.runs().map((r) => [r.forPeer, r.status, lou.store.tasks(r.id).length])).toEqual([['Sam', 'escalated', 4], ['Sam', 'escalated', 1]]);
});

test('after a restart, a goal that was with a peer is not given again: the run ends as escalated', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tuloy-')), 'tuloy.sqlite');
  const first = ownModelsDown({ file, peer: [refused, working] });
  // The program stops when the peer has the goal.
  first.store.subscribe((e) => e.taskId === 'goal' && e.action === 'dispatch' && first.store.close());
  const { runId, ended } = first.conductor.startRun(SAMPLE_GOAL);
  await ended.catch(() => {}); // the stopped conductor dies on the closed store

  const tuloy = testTuloy({ file, peer: [result(goalOutput)] });
  await tuloy.conductor.continueRuns()[0]!.ended;

  expect(tuloy.store.run(runId)?.status).toBe('escalated');
  expect(lines(tuloy, runId, (e) => e.taskId === 'goal')).toEqual(["assign Maria's conductor", 'dispatch started', 'watch missed_heartbeat', 'escalate escalated']);
  expect(goalTask(tuloy, runId).stuckReason).toBe(
    "Full goal task stalled: Tuloy restarted while the task was in work. Every path failed: the own script agent, the backup model, Maria's script agent, the full goal to Maria. The run ended as escalated.",
  );
  expect(tuloy.peer.calls).toEqual([]);
});

test("a peer that stays silent on the goal is found at four task time limits: the peer's run has four tasks", async () => {
  const tuloy = ownModelsDown({ peer: [refused, working] });

  const { runId, ended } = tuloy.conductor.startRun(SAMPLE_GOAL);
  await ended;

  const events = tuloy.store.events(runId).filter((e) => e.taskId === 'goal');
  expect(events.slice(-2).map((e) => [e.action, e.result, e.cause, e.time - events[0]!.time])).toEqual([
    ['watch', 'timeout', "Maria's conductor gave no result in 240s", 240_000],
    ['escalate', 'escalated', "every path failed: the own script agent, the backup model, Maria's script agent, the full goal to Maria", 240_000],
  ]);
  expect(tuloy.peer.calls.at(-1)!.move).toBe('cancel');
});

test('the demo command and the sample command turn on demo mode and the same-machine setting', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  // The settings that each command puts before `node`, as the program reads them.
  const settings = (command: string) => readSettings(Object.fromEntries([...command.split(' node ')[0]!.matchAll(/(\w+)=('[^']*'|\S+)/g)].map((m) => [m[1]!, m[2]!.replaceAll("'", '')])));

  expect(settings(scripts['start:demo']!)).toMatchObject({ demo: true, peerAllowLocal: true, owner: 'Owner', port: 4000 });
  expect(settings(scripts['start:sample']!)).toMatchObject({ demo: true, peerAllowLocal: true, owner: 'Sam (sample owner)', port: 4001, dataDir: './data/sample' });
  expect(settings(scripts.start!)).toMatchObject({ demo: false, peerAllowLocal: false });
});

// ---- Second pass, B: the full goal goes to the first peer that did not refuse the task in step 3 ----

const failedLater: A2aAnswer = { status: 'failed', failure: 'agent-failed', text: 'The script agent did not finish the task: escalated.', taskId: 'a2a-task-1', contextId: 'a2a-context-1' };
const withAna = (tuloy: ReturnType<typeof ownModelsDown>) => (tuloy.store.addPeer({ name: 'Ana', address: 'https://ana.example', sendKey: 'the-key-that-ana-accepts-from-this-tuloy', acceptKey: 'the-key-from-ana' }), tuloy);
const sentTo = ({ peer }: ReturnType<typeof ownModelsDown>) => peer.calls.filter((c) => c.move === 'send').map((c) => new URL(c.call.address).hostname);

test('the first peer refuses the task and the second takes it and fails: the full goal goes to the second peer, not to the one that refused', async () => {
  // Ana is the first peer of the allowed list, Maria the second.
  const tuloy = withAna(ownModelsDown({ peer: [refused, working, failedLater, working, result(goalOutput)] }));
  const { conductor, store } = tuloy;

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  expect(store.tasks(runId)).toMatchObject([{ id: 'goal', title: 'Give the full goal to Maria', status: 'done', agent: "Maria's conductor" }]);
  expect(store.events(runId).find((e) => e.action === 'goal_to_peer')).toMatchObject({ result: 'Maria', data: { peer: 'Maria', tried: ['the own script agent', 'the backup model', "Ana's script agent", "Maria's script agent"] } });
  expect(sentTo(tuloy)).toEqual(['ana.example', 'maria.example', 'maria.example']);
});

test('both peers refuse the task: the full goal is tried one time at the first peer, as before', async () => {
  const tuloy = withAna(ownModelsDown({ peer: [refused, refused, working, result(goalOutput)] }));
  const { conductor, store } = tuloy;

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  expect(store.tasks(runId)).toMatchObject([{ id: 'goal', title: 'Give the full goal to Ana', agent: "Ana's conductor" }]);
  expect(sentTo(tuloy)).toEqual(['ana.example', 'maria.example', 'ana.example']);
});
