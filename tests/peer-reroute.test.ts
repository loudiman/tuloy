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
