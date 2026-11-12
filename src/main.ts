import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from './clock.ts';
import { createConductor } from './conductor.ts';
import { openRouterModels } from './models.ts';
import { createPeerClient } from './peer-client.ts';
import { createServer } from './server.ts';
import { readSettings } from './settings.ts';
import { openStore } from './store.ts';

let settings;
let models;
try {
  settings = readSettings(process.env);
  models = openRouterModels(settings);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
mkdirSync(settings.dataDir, { recursive: true });
const store = openStore(join(settings.dataDir, 'tuloy.sqlite'), systemClock);
const conductor = createConductor({ store, models, clock: systemClock, limits: settings.limits, peerClient: createPeerClient({ allowLocal: settings.peerAllowLocal }), demo: settings.demo });
// Runs that were not finished at the last stop continue now, with no action from the owner.
conductor.continueRuns();
// TULOY_HOST is 127.0.0.1 unless the owner sets it. A Tuloy that is open to a network needs TULOY_DASHBOARD_PASSWORD (the settings refuse the start with none). The A2A endpoint takes work only with a key from the allowed list.
createServer({ store, conductor, owner: settings.owner, demo: settings.demo, peerTasksPerHour: settings.peerTasksPerHour, peerAllowLocal: settings.peerAllowLocal, host: settings.host, publicHost: settings.publicHost, password: settings.dashboardPassword }).listen(settings.port, settings.host, () => {
  console.log(`Tuloy of ${settings.owner}: http://localhost:${settings.port}`);
});
