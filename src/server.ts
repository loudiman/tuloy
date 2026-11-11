import http from 'node:http';
import type { Conductor } from './conductor.ts';
import { page } from './page.ts';
import { createPeerServer } from './peer-server.ts';
import { SAMPLE_GOAL } from './planner.ts';
import { roles, type Role } from './schemas.ts';
import type { Store } from './store.ts';
import { taskViews } from './task-view.ts';

/** The injection kinds that are built. The other kinds of the shared contract answer 400 until their ticket builds them. */
const injectionKinds = ['timeout', 'invalid_output'];

/** Serves the plain live page, its API, and the live event stream (server-sent events from the event log). */
export function createServer({ store, conductor, owner, peerTasksPerHour = 20, demo = false }: { store: Store; conductor: Conductor; owner: string; peerTasksPerHour?: number; demo?: boolean }) {
  const peerServer = createPeerServer({ store, conductor, owner, peerTasksPerHour });
  return http.createServer(async (req, res) => {
    if (await peerServer.handle(req, res)) return;
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const path = new URL(req.url ?? '/', 'http://tuloy').pathname;
    const runId = Number(/^\/api\/runs\/(\d+)$/.exec(path)?.[1]);

    if (req.method === 'GET' && path === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
    if (req.method === 'GET' && path === '/api/runs') return json(200, { owner, sampleGoal: SAMPLE_GOAL, runs: store.runs() });
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
      if (typeof task !== 'string' || !Object.hasOwn(roles, task)) return json(400, { error: `task must be an agent role: ${Object.keys(roles).join(', ')}` });
      if (typeof kind !== 'string' || !injectionKinds.includes(kind)) return json(400, { error: `kind must be one of: ${injectionKinds.join(', ')}` });
      return json(201, store.addInjection(task as Role, kind));
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
