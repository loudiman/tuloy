import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Message, type Task, TaskState } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { afterEach, expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { createServer } from '../src/server.ts';
import { goodOutput } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** One real Tuloy on a free port, with the scripted model. */
async function startTuloy(owner: string, options: Parameters<typeof testTuloy>[0] = {}) {
  const tuloy = testTuloy(options);
  const server = createServer({ store: tuloy.store, conductor: tuloy.conductor, owner });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stops.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { ...tuloy, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Puts a peer on the allowed list of the Tuloy at `url`. `acceptKey` is the key that Tuloy accepts from the peer. */
const allow = (url: string, peer: { name: string; address: string; sendKey: string; acceptKey: string }) =>
  fetch(`${url}/api/peers`, { method: 'POST', body: JSON.stringify(peer) });

/** What a peer's side does: the SDK's own client, made from the agent card. The key goes only in the Authorization header. */
async function peerClient(url: string, key?: string) {
  const client = await new ClientFactory().createFromUrl(url);
  const options = key ? { serviceParameters: { Authorization: `Bearer ${key}` } } : {};
  const read = (id: string) => client.getTask({ tenant: '', id, historyLength: 0 }, options);
  return {
    /** Sends one task for one agent role and returns at once. */
    send: (skill: string, input: unknown) =>
      client.sendMessage(
        {
          tenant: '',
          metadata: undefined,
          message: Message.fromJSON({ messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: JSON.stringify({ skill, input }) }] }),
          configuration: { acceptedOutputModes: [], taskPushNotificationConfig: undefined, historyLength: 0, returnImmediately: true },
        },
        options,
      ) as Promise<Task>,
    /** Polls the task until it is not working. */
    async ended(id: string): Promise<Task> {
      for (;;) {
        const task = await read(id);
        if (task.status?.state !== TaskState.TASK_STATE_WORKING) return task;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

const text = (task: Task) =>
  [...(task.status?.message?.parts ?? []), ...task.artifacts.flatMap((a) => a.parts)].map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('');

const scriptInput = { goal: SAMPLE_GOAL, trends: (goodOutput.trend_scout as any).trends };

/** Sam and Lou, each on the other's allowed list. */
async function twoPeers(samOptions: Parameters<typeof testTuloy>[0] = {}) {
  const sam = await startTuloy('Sam', samOptions);
  const lou = await startTuloy('Lou');
  await allow(sam.url, { name: 'Lou', address: lou.url, sendKey: 'key-from-sam', acceptKey: 'key-from-lou' });
  await allow(lou.url, { name: 'Sam', address: sam.url, sendKey: 'key-from-lou', acceptKey: 'key-from-sam' });
  return { sam, lou };
}

test('a peer on the allowed list sends one task for one agent role; the A2A task goes working, then completed with the checked output', async () => {
  const model = Promise.withResolvers<unknown>();
  const { sam } = await twoPeers({ script: { script: [model.promise] } });
  const lou = await peerClient(sam.url, 'key-from-lou');

  const sent = await lou.send('script', { ...scriptInput, junk: 'not in the schema' });
  expect(sent.status?.state).toBe(TaskState.TASK_STATE_WORKING);

  model.resolve({ ...(goodOutput.script as object), junk: 'not in the schema' });
  const done = await lou.ended(sent.id);

  expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(JSON.parse(text(done))).toEqual(goodOutput.script);
  // The agent ran once, on the checked fields only.
  expect(sam.model.calls.map((c) => [c.role, JSON.parse(c.prompt)])).toEqual([['script', scriptInput]]);
});

test('a request with no key, a wrong key, or the key of a Tuloy that is not on the allowed list is refused and nothing runs', async () => {
  const { sam } = await twoPeers();
  // Mallory is a real Tuloy with its own key, but Sam never put it on the allowed list.
  const mallory = await startTuloy('Mallory');
  await allow(mallory.url, { name: 'Sam', address: sam.url, sendKey: 'key-from-mallory', acceptKey: 'key-from-sam-to-mallory' });

  for (const key of [undefined, 'a-wrong-key', 'key-from-mallory', 'key-from-sam']) {
    const stranger = await peerClient(sam.url, key);
    await expect(stranger.send('script', scriptInput)).rejects.toThrow('401');
  }
  const raw = await fetch(`${sam.url}/a2a`, { method: 'POST', body: '{}' });

  expect(raw.status).toBe(401);
  expect(sam.model.calls).toEqual([]);
  expect(sam.store.runs()).toEqual([]);
});

test('the input from the peer is checked against the input schema of the role before the agent runs', async () => {
  const { sam } = await twoPeers();
  const lou = await peerClient(sam.url, 'key-from-lou');

  // The script agent needs trends. The reviewer's input is not the script agent's input.
  const noTrends = await lou.send('script', { goal: SAMPLE_GOAL });
  const noSuchRole = await lou.send('painter', scriptInput);

  expect(noTrends.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
  expect(text(noTrends)).toContain('input schema of the script agent');
  expect(text(noTrends)).toContain('trends');
  expect(noSuchRole.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
  expect(sam.model.calls).toEqual([]);
  expect(sam.store.runs()).toEqual([]);
});

test('the agent card is at the well-known address and lists a skill for each agent role', async () => {
  const sam = await startTuloy('Sam');

  const card = (await (await fetch(`${sam.url}/.well-known/agent-card.json`)).json()) as any;

  expect(card.name).toBe('Tuloy of Sam');
  expect(card.skills.map((s: any) => s.id)).toEqual(['trend_scout', 'script', 'reviewer', 'scheduler']);
  expect(card.supportedInterfaces).toEqual([{ url: `${sam.url}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
});
