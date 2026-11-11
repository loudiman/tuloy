/**
 * Two Tuloys for a check by hand in a browser: Lou and Sam (sample owner). No real model: the scripted model answers.
 *
 *   node tests/harness/two-fake-tuloys.ts [Lou's port] [Sam's port] [delay in ms for each model call]
 *
 * Make an invite on one peers screen and accept it on the other. When Lou has Sam on the allowed list,
 * Lou sends one task for Sam's script agent over A2A, one time. Sam's dashboard then shows a run "for Lou".
 */
import { randomUUID } from 'node:crypto';
import { Message } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { systemClock } from '../../src/clock.ts';
import { createConductor } from '../../src/conductor.ts';
import { SAMPLE_GOAL } from '../../src/planner.ts';
import { createServer } from '../../src/server.ts';
import { defaultLimits } from '../../src/settings.ts';
import { openStore } from '../../src/store.ts';
import { goodOutput, scriptedModel } from './scripted-model.ts';

const [louPort = '4100', samPort = '4101', delay = '1500'] = process.argv.slice(2);

function start(owner: string, port: string) {
  const model = scriptedModel();
  const answer = model.doGenerate;
  model.doGenerate = async (options) => {
    await new Promise((resolve) => setTimeout(resolve, Number(delay)));
    return answer(options);
  };
  const store = openStore(':memory:', systemClock);
  const conductor = createConductor({ store, models: { primary: model, backup: model }, clock: systemClock, limits: defaultLimits });
  createServer({ store, conductor, owner, demo: true }).listen(Number(port), '127.0.0.1', () => console.log(`Tuloy of ${owner}, scripted model: http://localhost:${port}`));
  return store;
}

const lou = start('Lou', louPort);
start('Sam (sample owner)', samPort);

const watch = setInterval(async () => {
  const [sam] = lou.peers();
  if (!sam) return;
  clearInterval(watch);
  // What ticket 9's peer client will do: the SDK's client, the key only in the Authorization header.
  const client = await new ClientFactory().createFromUrl(sam.address);
  const input = { goal: SAMPLE_GOAL, trends: (goodOutput.trend_scout as { trends: unknown }).trends };
  await client.sendMessage(
    {
      tenant: '',
      metadata: undefined,
      message: Message.fromJSON({ messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: JSON.stringify({ skill: 'script', input }) }] }),
      configuration: { acceptedOutputModes: [], taskPushNotificationConfig: undefined, historyLength: 0, returnImmediately: true },
    },
    { serviceParameters: { Authorization: `Bearer ${sam.sendKey}` } },
  );
  console.log(`Lou sent one task for the script agent to ${sam.name}.`);
}, 500);
