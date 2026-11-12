import { readFileSync } from 'node:fs';
import http from 'node:http';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { stripTypeScriptTypes } from 'node:module';
import { readBody, readJson } from './allowed-list.ts';
import type { Conductor } from './conductor.ts';
import { createPeerServer } from './peer-server.ts';
import { SAMPLE_GOAL } from './planner.ts';
import { skills, type Skill } from './schemas.ts';
import type { Store } from './store.ts';
import { recoverySummary, taskViews } from './task-view.ts';
import { tripOf } from './trip-view.ts';

/** The injection kinds that are built. The other kinds of the shared contract answer 400 until their ticket builds them. */
const injectionKinds = ['timeout', 'invalid_output', 'reviewer_rejection', 'primary_outage', 'all_models_outage', 'peer_silent', 'peer_refuses'];

const file = (path: string) => new URL(path, import.meta.url);
const font = (name: string) => file(`../node_modules/@fontsource-variable/${name}`);
/** The files of the dashboard: a fixed list, so no path from a request reaches the disk. */
const pageFiles: Record<string, { file: URL; type: string }> = {
  '/': { file: file('./page/index.html'), type: 'text/html; charset=utf-8' },
  '/page/style.css': { file: file('./page/style.css'), type: 'text/css; charset=utf-8' },
  '/page/app.ts': { file: file('./page/app.ts'), type: 'text/javascript; charset=utf-8' },
  '/page/view.ts': { file: file('./page/view.ts'), type: 'text/javascript; charset=utf-8' },
  '/page/theme.ts': { file: file('./page/theme.ts'), type: 'text/javascript; charset=utf-8' },
  '/page/street.ts': { file: file('./page/street.ts'), type: 'text/javascript; charset=utf-8' },
  // The 3D library comes from the repo's own packages, so the page needs no internet.
  '/vendor/three.module.js': { file: file('../node_modules/three/build/three.module.js'), type: 'text/javascript; charset=utf-8' },
  '/vendor/three.core.js': { file: file('../node_modules/three/build/three.core.js'), type: 'text/javascript; charset=utf-8' },
  '/vendor/OrbitControls.js': { file: file('../node_modules/three/examples/jsm/controls/OrbitControls.js'), type: 'text/javascript; charset=utf-8' },
  '/fonts/barlow-condensed.woff2': { file: file('../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-800-normal.woff2'), type: 'font/woff2' },
  '/fonts/archivo.woff2': { file: font('archivo/files/archivo-latin-standard-normal.woff2'), type: 'font/woff2' },
  '/fonts/martian-mono.woff2': { file: font('martian-mono/files/martian-mono-latin-wght-normal.woff2'), type: 'font/woff2' },
};

/** Serves the dashboard, its API, the A2A surface, and the live event stream (server-sent events from the event log). */
/**
 * `host` is the setting TULOY_HOST: the address that this Tuloy listens on. The owner's API takes a call under that name too.
 * `peerAllowLocal` is the setting TULOY_PEER_ALLOW_LOCAL: it permits an invite and an agent card at a plain-http address of this same machine.
 */
export function createServer({
  store,
  conductor,
  owner,
  peerTasksPerHour = 20,
  demo = false,
  peerAllowLocal = false,
  host = '127.0.0.1',
}: {
  store: Store;
  conductor: Conductor;
  owner: string;
  peerTasksPerHour?: number;
  demo?: boolean;
  peerAllowLocal?: boolean;
  host?: string;
}) {
  const peerServer = createPeerServer({ store, conductor, owner, peerTasksPerHour, allowLocal: peerAllowLocal });
  return http.createServer(async (req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const path = new URL(req.url ?? '/', 'http://tuloy').pathname;
    // There is no login, so a web page that the owner has open in the same browser could call the owner's API.
    // Each call, a read included, must name this Tuloy's own address in Host (a name of another site that points here,
    // DNS rebinding, does not), and its Origin, when the browser sends one, must be that same address.
    // Not checked: the A2A endpoint (the key is the proof), the agent card (public) and an invite link (the token is the proof).
    if (path !== '/a2a' && path !== `/${AGENT_CARD_PATH}` && !path.startsWith('/invite/')) {
      const named = req.headers.host;
      const own = ['localhost', '127.0.0.1', host].map((name) => `${name}:${req.socket.localPort}`);
      const origin = req.headers.origin;
      if (!named || !own.includes(named) || (origin !== undefined && URL.parse(origin)?.host !== named)) return json(403, { error: 'Only this Tuloy\'s own page can do this.' });
    }
    if (await peerServer.handle(req, res)) return;
    const runId = Number(/^\/api\/runs\/(\d+)$/.exec(path)?.[1]);

    const pageFile = req.method === 'GET' ? pageFiles[path] : undefined;
    if (pageFile) {
      // ponytail: no bundler. The browser gets the page's TypeScript with the types removed by Node. Read on each request: the files are small.
      const body = readFileSync(pageFile.file);
      return res.writeHead(200, { 'content-type': pageFile.type }).end(path.endsWith('.ts') ? stripTypeScriptTypes(body.toString()) : body);
    }
    if (req.method === 'GET' && path === '/api/runs') return json(200, { owner, demo, sampleGoal: SAMPLE_GOAL, peers: store.peers().map((p) => p.name), runs: store.runs() });
    if (req.method === 'POST' && path === '/api/runs') {
      // An empty body starts the labelled sample goal.
      const body = await readBody(req);
      let goal: unknown;
      try {
        goal = body === '' ? SAMPLE_GOAL : JSON.parse(body ?? '').goal;
      } catch {}
      if (typeof goal !== 'string' || !goal.trim() || goal.length > 2000) return json(400, { error: 'goal must be a short text' });
      return json(201, { runId: conductor.startRun(goal).runId });
    }
    if (req.method === 'GET' && runId) {
      const run = store.run(runId);
      const events = store.events(runId);
      if (!run) return json(404, { error: 'no such run' });
      // The trip shows the stops of the first task graph also after the full goal went to a peer (version 2).
      const trip = tripOf(run, [...store.tasks(runId, 1), ...store.tasks(runId)], events);
      return json(200, { run, tasks: taskViews(store.tasks(runId), events), events, recovery: recoverySummary(events), trip });
    }
    // Injection exists only in demo mode. `task` is an agent role; the default is the script task.
    if (demo && req.method === 'GET' && path === '/api/injections') return json(200, { demo: true, injections: store.injections() });
    // The owner clears the pending injections, so that none stays for a later run.
    if (demo && req.method === 'DELETE' && path === '/api/injections') return (store.clearInjections(), res.writeHead(204).end());
    if (demo && req.method === 'POST' && path === '/api/injections') {
      const { task = 'script', kind } = ((await readJson(req)) ?? {}) as { task?: unknown; kind?: unknown };
      if (typeof task !== 'string' || !Object.hasOwn(skills, task)) return json(400, { error: `task must be an agent role, or goal for the full goal at a peer: ${Object.keys(skills).join(', ')}` });
      if (typeof kind !== 'string' || !injectionKinds.includes(kind)) return json(400, { error: `kind must be one of: ${injectionKinds.join(', ')}` });
      return json(201, store.addInjection(task as Skill, kind));
    }
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': connected\n\n');
      const stop = store.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
      req.on('close', stop);
      return;
    }
    json(404, { error: 'not found' });
  });
}
