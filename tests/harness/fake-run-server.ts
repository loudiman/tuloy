/**
 * One Tuloy for a check by hand in a browser. It never calls a real model: the scripted model answers.
 *
 *   node tests/harness/fake-run-server.ts [port] [delay in ms for each model call]
 *
 * Real clock, store in memory, demo mode on. The first run ends as escalated (the reviewer rejects the scripts);
 * each later run ends as done.
 */
import { createConductor } from '../../src/conductor.ts';
import { createServer } from '../../src/server.ts';
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

const store = openStore(':memory:', { now: Date.now });
const conductor = createConductor({ store, models: { primary: model, backup: model } });
createServer({ store, conductor, owner: 'Lou (scripted model, no real agent)', demo: true }).listen(port, '127.0.0.1', () => {
  console.log(`Tuloy with the scripted model: http://localhost:${port}`);
});
