import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConductor } from './conductor.ts';
import { openRouterModels } from './models.ts';
import { createServer } from './server.ts';
import { readSettings } from './settings.ts';
import { openStore } from './store.ts';

const settings = readSettings(process.env);
let models;
try {
  models = openRouterModels(settings);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
mkdirSync(settings.dataDir, { recursive: true });
const store = openStore(join(settings.dataDir, 'tuloy.sqlite'), { now: Date.now });
const conductor = createConductor({ store, models });
// ponytail: loopback only, there is no login for the page and its API. The A2A endpoint takes work only with a key from the allowed list.
createServer({ store, conductor, owner: settings.owner, peerTasksPerHour: settings.peerTasksPerHour }).listen(settings.port, '127.0.0.1', () => {
  console.log(`Tuloy of ${settings.owner}: http://localhost:${settings.port}`);
});
