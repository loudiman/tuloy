import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { createServer } from '../src/server.ts';
import type { TuloyEvent } from '../src/store.ts';
import { goodOutput } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

async function startTestServer(options: { demo?: boolean } = {}) {
  const { conductor, store } = testTuloy();
  const server = createServer({ store, conductor, owner: 'Lou', ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Reads the live event stream until the run ends. */
async function eventsUntilEnd(response: Response): Promise<TuloyEvent[]> {
  const events: TuloyEvent[] = [];
  let buffer = '';
  for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const frames = buffer.split('\n\n');
    buffer = frames.pop()!;
    for (const frame of frames) if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)));
    if (events.at(-1)?.action === 'end') break;
  }
  return events;
}

test('the owner starts the sample goal in one action, the page gets each event live, and a refresh reads the same state', async () => {
  const { server, url } = await startTestServer();
  try {
    const stream = await fetch(`${url}/api/events`);

    const started = await fetch(`${url}/api/runs`, { method: 'POST' });
    const { runId } = (await started.json()) as { runId: number };
    const live = await eventsUntilEnd(stream);

    // A refresh: the page reads the list of runs and then the newest run.
    const list = (await (await fetch(`${url}/api/runs`)).json()) as any;
    const state = (await (await fetch(`${url}/api/runs/${list.runs[0].id}`)).json()) as any;
    expect(list).toMatchObject({ owner: 'Lou', sampleGoal: SAMPLE_GOAL, runs: [{ id: runId, goal: SAMPLE_GOAL, status: 'done' }] });
    expect(state.run).toMatchObject({ id: runId, goal: SAMPLE_GOAL, status: 'done' });
    expect(state.tasks.map((t: any) => [t.title, t.agent, t.status])).toEqual([
      ['Find trends', 'trend_scout', 'done'],
      ['Write scripts', 'script', 'done'],
      ['Review scripts', 'reviewer', 'done'],
      ['Make the posting schedule', 'scheduler', 'done'],
    ]);
    expect(state.tasks[3].output).toEqual(goodOutput.scheduler);
    expect(state.events).toEqual(live);
    expect(live).toHaveLength(18);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the page labels the sample goal as a sample', async () => {
  const { server, url } = await startTestServer();
  try {
    const page = await fetch(url);
    const html = await page.text();

    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html).toContain('Start the sample goal');
    expect(html).toContain('Sample goal');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('an unknown run is a 404', async () => {
  const { server, url } = await startTestServer();
  try {
    expect((await fetch(`${url}/api/runs/99`)).status).toBe(404);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the server sends the dashboard: the page, its style, its two scripts as JavaScript with no types, and the fonts', async () => {
  const { server, url } = await startTestServer();
  try {
    const html = await (await fetch(url)).text();
    for (const part of ['/page/style.css', '/page/app.ts', '/fonts/archivo.woff2', '/fonts/martian-mono.woff2']) expect(html).toContain(part);

    const view = await fetch(`${url}/page/view.ts`);
    const script = await view.text();
    expect(view.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script).toContain('export function shownStatus(');
    expect(script).not.toContain('export type');

    expect((await fetch(`${url}/page/app.ts`)).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await fetch(`${url}/page/style.css`)).headers.get('content-type')).toBe('text/css; charset=utf-8');
    const font = await fetch(`${url}/fonts/archivo.woff2`);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
    expect((await fetch(`${url}/fonts/martian-mono.woff2`)).status).toBe(200);
    expect((await fetch(`${url}/page/../server.ts`)).status).toBe(404);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the list of runs says if this Tuloy is in demo mode', async () => {
  const off = await startTestServer();
  const on = await startTestServer({ demo: true });
  try {
    expect(((await (await fetch(`${off.url}/api/runs`)).json()) as any).demo).toBe(false);
    expect(((await (await fetch(`${on.url}/api/runs`)).json()) as any).demo).toBe(true);
  } finally {
    for (const { server } of [off, on]) {
      server.closeAllConnections();
      server.close();
    }
  }
});
