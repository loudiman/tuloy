import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { createServer } from '../src/server.ts';
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

test('the agent card is at the well-known address and lists a skill for each agent role', async () => {
  const sam = await startTuloy('Sam');

  const card = (await (await fetch(`${sam.url}/.well-known/agent-card.json`)).json()) as any;

  expect(card.name).toBe('Tuloy of Sam');
  expect(card.skills.map((s: any) => s.id)).toEqual(['trend_scout', 'script', 'reviewer', 'scheduler']);
  expect(card.supportedInterfaces).toEqual([{ url: `${sam.url}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
});
