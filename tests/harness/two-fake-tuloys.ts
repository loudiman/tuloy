/**
 * Two Tuloys for a check by hand in a browser: Lou and Sam (sample owner). No real model: the scripted model answers.
 *
 *   node tests/harness/two-fake-tuloys.ts [Lou's port] [Sam's port] [delay in ms for each model call] [port of a third Tuloy, Mika]
 *
 * Both are in demo mode and permit a peer on this same machine, as `pnpm start:demo` and `pnpm start:sample` do.
 * Follow the README section "Run two Tuloys on one laptop" from step 3, with these two ports.
 */
import { systemClock } from '../../src/clock.ts';
import { createConductor } from '../../src/conductor.ts';
import { createPeerClient } from '../../src/peer-client.ts';
import { createServer } from '../../src/server.ts';
import { defaultLimits } from '../../src/settings.ts';
import { openStore } from '../../src/store.ts';
import { scriptedModel } from './scripted-model.ts';

const [louPort = '4100', samPort = '4101', delay = '1500', mikaPort] = process.argv.slice(2);

function start(owner: string, port: string) {
  const model = scriptedModel();
  const answer = model.doGenerate;
  model.doGenerate = async (options) => {
    await new Promise((resolve) => setTimeout(resolve, Number(delay)));
    return answer(options);
  };
  const store = openStore(':memory:', systemClock);
  const conductor = createConductor({ store, models: { primary: model, backup: model }, clock: systemClock, limits: defaultLimits, peerClient: createPeerClient({ allowLocal: true }), demo: true });
  createServer({ store, conductor, owner, demo: true, peerAllowLocal: true }).listen(Number(port), '127.0.0.1', () => console.log(`Tuloy of ${owner}, scripted model: http://localhost:${port}`));
}

start('Lou', louPort);
start('Sam (sample owner)', samPort);
if (mikaPort) start('Mika (sample owner)', mikaPort);
