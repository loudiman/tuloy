import http from 'node:http';
import type { Conductor } from './conductor.ts';
import { page } from './page.ts';
import { createPeerServer } from './peer-server.ts';
import { SAMPLE_GOAL } from './planner.ts';
import type { Store } from './store.ts';

/** Serves the plain live page, its API, and the live event stream (server-sent events from the event log). */
export function createServer({ store, conductor, owner }: { store: Store; conductor: Conductor; owner: string }) {
  const peerServer = createPeerServer({ store, conductor, owner });
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
      return run ? json(200, { run, tasks: store.tasks(runId), events: store.events(runId) }) : json(404, { error: 'no such run' });
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
