/**
 * One Tuloy for a check by hand in a browser. It never calls a real model: the scripted model answers.
 *
 *   node tests/harness/fake-run-server.ts [port] [delay in ms for each model call]
 *
 * Real clock, store in memory, demo mode on, default limits. The first run ends as escalated (the reviewer rejects
 * the scripts); each later run ends as done. Use the demo injections on the page to see a recovery.
 */
import { systemClock } from '../../src/clock.ts';
import { createConductor } from '../../src/conductor.ts';
import { createServer } from '../../src/server.ts';
import { defaultLimits } from '../../src/settings.ts';
import { openStore } from '../../src/store.ts';
import { scriptedModel } from './scripted-model.ts';

const port = Number(process.argv[2] ?? 4100);
const delay = Number(process.argv[3] ?? 1500);

const rejected = {
  reviews: [
    { script_id: 's1', verdict: 'reject', issues: ['The hook does not name the store.'] },
    { script_id: 's2', verdict: 'pass', issues: [] },
  ],
};
const model = scriptedModel({ reviewer: [rejected] });
const answer = model.doGenerate;
model.doGenerate = async (options) => {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return answer(options);
};

const store = openStore(':memory:', systemClock);
const conductor = createConductor({ store, models: { primary: model, backup: model }, clock: systemClock, limits: defaultLimits });
createServer({ store, conductor, owner: 'Lou (scripted model, no real agent)', demo: true }).listen(port, '127.0.0.1', () => {
  console.log(`Tuloy with the scripted model: http://localhost:${port}`);
});
