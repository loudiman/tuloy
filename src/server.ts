import { readFileSync } from 'node:fs';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import type { Conductor } from './conductor.ts';
import { SAMPLE_GOAL } from './planner.ts';
import type { Store } from './store.ts';

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

/** Serves the dashboard, its API, and the live event stream (server-sent events from the event log). */
export function createServer({ store, conductor, owner, demo = false }: { store: Store; conductor: Conductor; owner: string; demo?: boolean }) {
  return http.createServer(async (req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const path = new URL(req.url ?? '/', 'http://tuloy').pathname;
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
