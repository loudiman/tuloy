import { expect, test } from 'vitest';
import type { A2aAnswer } from '../src/peer-client.ts';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { taskViews } from '../src/task-view.ts';
import { goodOutput } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

type Tuloy = ReturnType<typeof testTuloy>;
/** The events of one task as short lines: "action result". */
const trail = ({ store }: Tuloy, runId: number, taskId: string) => store.events(runId).filter((e) => e.taskId === taskId).map((e) => `${e.action} ${e.result}`);
const task = ({ store }: Tuloy, runId: number, taskId: string) => store.tasks(runId).find((t) => t.id === taskId)!;

const KEY = 'the-key-that-maria-accepts-from-this-tuloy';
const ids = { taskId: 'a2a-task-1', contextId: 'a2a-context-1' };
const working: A2aAnswer = { status: 'progress', ...ids };
const result = (output: unknown): A2aAnswer => ({ status: 'result', text: JSON.stringify(output), ...ids });
const down = () => new Error('503 model down');

/** A Tuloy whose primary and backup model are down for the script task, with Maria on the allowed list. */
function ownModelsDown(options: Parameters<typeof testTuloy>[0] = {}) {
  const tuloy = testTuloy({ script: { script: [down()] }, backupScript: { script: [down()] }, ...options });
  tuloy.store.addPeer({ name: 'Maria', address: 'https://maria.example', sendKey: KEY, acceptKey: 'the-key-from-maria' });
  return tuloy;
}

test('with the primary and the backup model down, the task goes to the same agent of a peer, and the run ends as done', async () => {
  const tuloy = ownModelsDown({ peer: [working, working, result(goodOutput.script)] });
  const { conductor, store, clock, model, peer } = tuloy;
  const start = clock.now();
  const seen: [string, string, string | null][] = [];
  store.subscribe((e) => {
    const view = taskViews(store.tasks(e.runId), store.events(e.runId)).find((t) => t.id === 'scripts')!;
    if (e.taskId === 'scripts' && e.action === 'dispatch') seen.push([view.status, view.shownStatus, view.stuckReason]);
  });

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('done');
  expect(task(tuloy, runId, 'scripts')).toMatchObject({ status: 'done', output: goodOutput.script, agent: "Maria's script agent" });
  expect(trail(tuloy, runId, 'scripts')).toEqual([
    'assign script',
    'handoff checked content stored',
    'dispatch started',
    'model_call model_unavailable',
    'reroute backup model',
    'dispatch started',
    'model_call model_unavailable',
    "reroute Maria's script agent",
    'dispatch started',
    'heartbeat alive',
    'validate valid',
    'review pass',
  ]);
  // The peer gets the one task with the same checked input, at its A2A address, and is then polled.
  const input = JSON.parse(model.calls.find((c) => c.role === 'script')!.prompt);
  expect(peer.calls).toMatchObject([
    { move: 'send', call: { address: 'https://maria.example/a2a', key: KEY, text: JSON.stringify({ skill: 'script', input }) } },
    { move: 'read', call: { address: 'https://maria.example/a2a', key: KEY, taskId: 'a2a-task-1' } },
    { move: 'read', call: { taskId: 'a2a-task-1' } },
  ]);
  const rerouted = store.events(runId).find((e) => e.action === 'reroute' && e.result !== 'backup model')!;
  expect(rerouted).toMatchObject({ cause: 'the backup model also failed', data: { do: 'peer', peer: 'Maria' }, time: start });
  // Two polls, one each 5 s.
  expect(store.events(runId).find((e) => e.taskId === 'scripts' && e.action === 'validate')!.time - start).toBe(10_000);
  expect(seen[2]).toEqual(['recovering', 'recovering', "Script task failed: the model is not available (503 model down). Re-routed to Maria's script agent after the backup model also failed."]);
  // The key is in no event.
  expect(JSON.stringify(store.events(runId))).not.toContain(KEY);
});

const scriptsEvents = ({ store }: Tuloy, runId: number) => store.events(runId).filter((e) => e.taskId === 'scripts');
const stuckReason = ({ store }: Tuloy, runId: number) => taskViews(store.tasks(runId), store.events(runId)).find((t) => t.id === 'scripts')!.stuckReason;

test.each<[string, A2aAnswer[], string, string, number]>([
  ['refuses', [{ status: 'refused', text: 'I do not take this work.', ...ids }], 'peer_call peer_failed', 'Script task failed: Maria refused the task: I do not take this work. The re-route to a peer failed. The run ended as escalated.', 1],
  [
    'is over its limit for this Tuloy',
    [{ status: 'refused', text: 'Lou is at the limit of 20 tasks per hour.', ...ids }],
    'peer_call peer_failed',
    'Script task failed: Maria refused the task: Lou is at the limit of 20 tasks per hour. The re-route to a peer failed. The run ended as escalated.',
    1,
  ],
  [
    'fails after it took the task',
    [working, { status: 'failed', failure: 'agent-failed', text: 'The script agent did not finish the task: escalated.', ...ids }],
    'peer_call peer_failed',
    "Script task failed: Maria's script agent failed: The script agent did not finish the task: escalated. The re-route to a peer failed. The run ended as escalated.",
    2,
  ],
  [
    'cannot be reached',
    [{ status: 'failed', failure: 'unreachable', text: 'The outside agent could not be reached.', taskId: null, contextId: null }],
    'peer_call peer_failed',
    "Script task failed: Maria's script agent failed: The outside agent could not be reached. The re-route to a peer failed. The run ended as escalated.",
    1,
  ],
  [
    'asks a question',
    [{ status: 'ask', text: 'Which store?', ...ids }],
    'peer_call peer_failed',
    "Script task failed: Maria's script agent asked a question, and a run has nobody to answer it. The re-route to a peer failed. The run ended as escalated.",
    2,
  ],
  ['gives a payload that does not match the schema', [working, result({ scripts: 'junk' })], 'validate invalid_output', 'Script task failed: its output did not match the schema. The re-route to a peer failed. The run ended as escalated.', 2],
  ['gives a result that is not JSON', [{ status: 'result', text: 'Here are your scripts!', ...ids }], 'validate invalid_output', 'Script task failed: its output did not match the schema. The re-route to a peer failed. The run ended as escalated.', 1],
])('a peer that %s makes the peer step fail fast, and the run ends as escalated', async (_name, answers, failure, reason, calls) => {
  const tuloy = ownModelsDown({ peer: answers });
  const { conductor, store, clock, peer } = tuloy;
  const start = clock.now();

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('escalated');
  expect(trail(tuloy, runId, 'scripts').slice(-4)).toEqual(["reroute Maria's script agent", 'dispatch started', failure, 'escalate escalated']);
  expect(task(tuloy, runId, 'scripts')).toMatchObject({ status: 'escalated', output: null });
  expect(stuckReason(tuloy, runId)).toBe(reason);
  // Fast: one attempt, no retry, no second peer call after the answer.
  expect(peer.calls).toHaveLength(calls);
  expect(clock.now() - start).toBeLessThanOrEqual(5000);
  // Nothing is passed on to the reviewer.
  expect(store.events(runId).some((e) => e.taskId === 'review')).toBe(false);
});

test('with an empty allowed list the peer step is passed at once, with no call, and the run ends as escalated', async () => {
  const tuloy = testTuloy({ script: { script: [down()] }, backupScript: { script: [down()] } });
  const { conductor, store, peer } = tuloy;

  const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
  await ended;

  expect(store.run(runId)?.status).toBe('escalated');
  expect(trail(tuloy, runId, 'scripts').slice(-4)).toEqual(['reroute backup model', 'dispatch started', 'model_call model_unavailable', 'escalate escalated']);
  expect(scriptsEvents(tuloy, runId).at(-1)).toMatchObject({ action: 'escalate', cause: 'the backup model also failed' });
  expect(stuckReason(tuloy, runId)).toBe('Script task failed: the model is not available (503 model down). The backup model also failed. The run ended as escalated.');
  expect(peer.calls).toEqual([]);
});
