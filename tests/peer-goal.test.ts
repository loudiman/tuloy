import { expect, test } from 'vitest';
import type { A2aAnswer } from '../src/peer-client.ts';
import { SAMPLE_GOAL } from '../src/planner.ts';
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
  ["a peer's script that the own reviewer rejects: the full goal goes to a peer", fail('reviewer_rejection', { onPeer: true }), earlier, own, goal],
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
const sends = ({ peer }: Tuloy) => peer.calls.filter((c) => c.move === 'send').map((c) => JSON.parse((c.call as { text: string }).text));

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
