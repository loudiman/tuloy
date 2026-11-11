import { readFileSync } from 'node:fs';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import type { Conductor } from './conductor.ts';
import { createPeerServer } from './peer-server.ts';
import { SAMPLE_GOAL } from './planner.ts';
import { skills, type Skill } from './schemas.ts';
import type { Store } from './store.ts';
import { taskViews } from './task-view.ts';

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
  '/fonts/archivo.woff2': { file: font('archivo/files/archivo-latin-standard-normal.woff2'), type: 'font/woff2' },
  '/fonts/martian-mono.woff2': { file: font('martian-mono/files/martian-mono-latin-wght-normal.woff2'), type: 'font/woff2' },
};

/** Serves the dashboard, its API, the A2A surface, and the live event stream (server-sent events from the event log). */
export function createServer({ store, conductor, owner, peerTasksPerHour = 20, demo = false }: { store: Store; conductor: Conductor; owner: string; peerTasksPerHour?: number; demo?: boolean }) {
  const peerServer = createPeerServer({ store, conductor, owner, peerTasksPerHour });
  return http.createServer(async (req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const path = new URL(req.url ?? '/', 'http://tuloy').pathname;
    // There is no login, so a web page that the owner has open in the same browser could call the owner's API.
    // Each call that changes something must name this Tuloy's own address in Host (a name of another site that points here,
    // DNS rebinding, does not), and its Origin, when the browser sends one, must be that same address.
    // Not checked: the A2A endpoint (the key is the proof) and the answer to an invite (the token is the proof).
    if (req.method !== 'GET' && path !== '/a2a' && !path.startsWith('/invite/')) {
      const host = req.headers.host;
      const own = ['localhost', '127.0.0.1'].map((name) => `${name}:${req.socket.localPort}`);
      const origin = req.headers.origin;
      if (!host || !own.includes(host) || (origin !== undefined && URL.parse(origin)?.host !== host)) return json(403, { error: 'Only this Tuloy\'s own page can do this.' });
    }
    if (await peerServer.handle(req, res)) return;
    const runId = Number(/^\/api\/runs\/(\d+)$/.exec(path)?.[1]);

    const pageFile = req.method === 'GET' ? pageFiles[path] : undefined;
    if (pageFile) {
      // ponytail: no bundler. The browser gets the page's TypeScript with the types removed by Node. Read on each request: the files are small.
      const body = readFileSync(pageFile.file);
      return res.writeHead(200, { 'content-type': pageFile.type }).end(path.endsWith('.ts') ? stripTypeScriptTypes(body.toString()) : body);
    }
    if (req.method === 'GET' && path === '/api/runs') return json(200, { owner, demo, sampleGoal: SAMPLE_GOAL, runs: store.runs() });
    if (req.method === 'POST' && path === '/api/runs') {
      // An empty body starts the labelled sample goal.
      let body = '';
      for await (const chunk of req) body += chunk;
      let goal: unknown;
      try {
        goal = body ? JSON.parse(body).goal : SAMPLE_GOAL;
      } catch {}
      if (typeof goal !== 'string' || !goal.trim() || goal.length > 2000) return json(400, { error: 'goal must be a short text' });
      return json(201, { runId: conductor.startRun(goal).runId });
    }
    if (req.method === 'GET' && runId) {
      const run = store.run(runId);
      const events = store.events(runId);
      return run ? json(200, { run, tasks: taskViews(store.tasks(runId), events), events }) : json(404, { error: 'no such run' });
    }
    // Injection exists only in demo mode. `task` is an agent role; the default is the script task.
    if (demo && req.method === 'GET' && path === '/api/injections') return json(200, { demo: true, injections: store.injections() });
    if (demo && req.method === 'POST' && path === '/api/injections') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let wanted: { task?: unknown; kind?: unknown } = {};
      try {
        wanted = JSON.parse(body) ?? {};
      } catch {}
      const { task = 'script', kind } = wanted;
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
