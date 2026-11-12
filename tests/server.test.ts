import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { SAMPLE_GOAL } from '../src/planner.ts';
import { createServer } from '../src/server.ts';
import type { TuloyEvent } from '../src/store.ts';
import { goodOutput } from './harness/scripted-model.ts';
import { testTuloy } from './harness/tuloy.ts';

async function startTestServer(options: { demo?: boolean; host?: string; publicHost?: string; password?: string; publicRead?: boolean } = {}) {
  const { conductor, store } = testTuloy();
  const server = createServer({ store, conductor, owner: 'Lou', ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, store, conductor, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
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

test('the dashboard has a field for a goal that the owner types, and a link to the peers screen; the peers screen has the look of the dashboard', async () => {
  const { server, url } = await startTestServer();
  try {
    const html = await (await fetch(url)).text();
    expect(html).toContain('<form id="goal-form"');
    expect(html).toContain('Start this goal');
    expect(html).toContain('href="/peers"');

    const peers = await (await fetch(`${url}/peers`)).text();
    expect(peers).toContain('href="/page/style.css"');
    expect(peers).toContain('href="/"');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- Review fix 1: only this Tuloy's own page can call the owner's API ----

/** One call with the headers as given: `fetch` cannot set Host. Returns the status. */
function rawCall(url: string, method: string, path: string, headers: Record<string, string>, body = ''): Promise<number> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname, port, method, path, headers }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('a web page of another origin cannot start a run, inject a failure or change the allowed list; a name that points at this Tuloy (DNS rebinding) cannot either', async () => {
  const { server, url, store } = await startTestServer({ demo: true });
  const { host, port } = new URL(url);
  try {
    const otherPage = { host, origin: 'https://evil.example' };
    // DNS rebinding: the page of evil.example calls its own name, which now points at 127.0.0.1. Origin and Host agree.
    const rebound = { host: `evil.example:${port}`, origin: `http://evil.example:${port}` };
    const noOrigin = { host: `evil.example:${port}` };
    for (const headers of [otherPage, rebound, noOrigin]) {
      expect([
        await rawCall(url, 'POST', '/api/runs', headers),
        await rawCall(url, 'POST', '/api/injections', headers, '{"kind":"timeout"}'),
        await rawCall(url, 'DELETE', '/api/injections', headers),
        await rawCall(url, 'POST', '/api/invites', headers),
        await rawCall(url, 'POST', '/api/peers', headers, JSON.stringify({ name: 'Evil', address: 'https://evil.example', sendKey: 'k' })),
        await rawCall(url, 'DELETE', '/api/peers/Lou', headers),
      ]).toEqual([403, 403, 403, 403, 403, 403]);
    }
    expect([store.runs(), store.injections(), store.peers()]).toEqual([[], [], []]);

    // This Tuloy's own page, by both names of this machine, and a call with no Origin (curl).
    expect(await rawCall(url, 'POST', '/api/runs', { host, origin: url })).toBe(201);
    expect(await rawCall(url, 'POST', '/api/runs', { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(201);
    expect(await rawCall(url, 'POST', '/api/runs', { host })).toBe(201);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- Review fix 6: every body that the server reads has the size limit ----

test('a body of more than 1 MB is refused: no run starts and no injection is stored', async () => {
  const { server, url, store } = await startTestServer({ demo: true });
  const padding = 'x'.repeat(1_100_000);
  try {
    const run = await fetch(`${url}/api/runs`, { method: 'POST', body: JSON.stringify({ goal: 'A short goal.', padding }) });
    const injection = await fetch(`${url}/api/injections`, { method: 'POST', body: JSON.stringify({ kind: 'timeout', padding }) });

    expect([run.status, injection.status]).toEqual([400, 400]);
    expect([store.runs(), store.injections()]).toEqual([[], []]);
    // The same bodies with no padding are accepted, and an empty body is still the sample goal.
    expect((await fetch(`${url}/api/runs`, { method: 'POST', body: JSON.stringify({ goal: 'A short goal.' }) })).status).toBe(201);
    expect((await fetch(`${url}/api/runs`, { method: 'POST' })).status).toBe(201);
    expect(store.runs().map((r) => r.goal)).toEqual([SAMPLE_GOAL, 'A short goal.']);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- Review fix 11: the setting TULOY_HOST, for a Tuloy that serves other machines ----

test('with a configured host, the owner\'s API takes a call that names that host, and still refuses another site', async () => {
  const { server, url, store } = await startTestServer({ host: '192.168.1.20' });
  const { port } = new URL(url);
  try {
    const own = `192.168.1.20:${port}`;
    expect(await rawCall(url, 'POST', '/api/runs', { host: own, origin: `http://${own}` })).toBe(201);
    expect(await rawCall(url, 'POST', '/api/runs', { host: `localhost:${port}` })).toBe(201);
    expect(await rawCall(url, 'POST', '/api/runs', { host: own, origin: 'https://evil.example' })).toBe(403);
    expect(await rawCall(url, 'POST', '/api/runs', { host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toBe(403);
    expect(await rawCall(url, 'POST', '/api/runs', { host: `192.168.1.21:${port}` })).toBe(403);
    expect(store.runs()).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- Review fix 13: the words of the glossary in the UI text ----

test('the UI text uses the words of the glossary: re-route (not model switch), and a task or a goal (not a request)', async () => {
  const { server, url } = await startTestServer();
  try {
    const app = await (await fetch(`${url}/page/app.ts`)).text();
    const peers = await (await fetch(`${url}/peers`)).text();

    expect(app).not.toMatch(/model switch/i);
    expect(app).toContain('Handoffs, retries and re-routes show here as they happen.');
    expect(peers).not.toMatch(/request/i);
    expect(peers).toContain('Its next task or goal is refused.');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- Second pass, A: the Host check is for every route of the owner's API, a read included ----

test('a name that points at this Tuloy (DNS rebinding) cannot read the runs, the peers, the injections or the live events; the agent card and an invite link stay open', async () => {
  const { server, url, store, conductor } = await startTestServer({ demo: true });
  const { host, port } = new URL(url);
  try {
    const { runId, ended } = conductor.startRun(SAMPLE_GOAL);
    await ended;
    const rebound = { host: `evil.example:${port}` };
    const reads = ['/api/runs', `/api/runs/${runId}`, '/api/peers', '/api/injections', '/api/events', '/', '/peers', '/page/app.ts'];

    for (const path of reads) expect([path, await rawCall(url, 'GET', path, rebound)]).toEqual([path, 403]);
    // Another site that calls this Tuloy by its own name: the browser names that site in Origin.
    expect(await rawCall(url, 'GET', '/api/runs', { host, origin: 'https://evil.example' })).toBe(403);

    // This Tuloy's own page reads all of them, by both names of this machine.
    for (const path of reads.filter((p) => p !== '/api/events')) {
      expect([path, await rawCall(url, 'GET', path, { host })]).toEqual([path, 200]);
      expect([path, await rawCall(url, 'GET', path, { host: `localhost:${port}` })]).toEqual([path, 200]);
    }
    expect((await fetch(`${url}/api/events`)).status).toBe(200);
    // For everybody: the agent card (a peer reads it) and an invite link that a person opens.
    expect(await rawCall(url, 'GET', '/.well-known/agent-card.json', rebound)).toBe(200);
    expect(await rawCall(url, 'GET', '/invite/abc', rebound)).toBe(200);
    expect(store.runs()).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- A Tuloy on a public address: a password for the page and its API, and the public name of the host ----

test('with a password, the page and its API ask for it; the agent card and the A2A endpoint do not', async () => {
  const { server, url, store } = await startTestServer({ password: 'a-long-test-password', publicHost: 'lou.example.com' });
  const { host } = new URL(url);
  const basic = (password: string) => `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;
  try {
    expect(await rawCall(url, 'GET', '/', { host })).toBe(401);
    expect(await rawCall(url, 'GET', '/api/runs', { host })).toBe(401);
    expect(await rawCall(url, 'POST', '/api/runs', { host, authorization: basic('a-wrong-test-password') })).toBe(401);
    expect(await rawCall(url, 'GET', '/api/events', { host, authorization: 'Bearer a-long-test-password' })).toBe(401);
    expect(store.runs()).toHaveLength(0);
    expect(await rawCall(url, 'GET', '/', { host, authorization: basic('a-long-test-password') })).toBe(200);
    expect(await rawCall(url, 'POST', '/api/runs', { host, authorization: basic('a-long-test-password') })).toBe(201);
    // The public name of the host, as a browser behind the provider's https sends it: no port.
    expect(await rawCall(url, 'GET', '/api/runs', { host: 'lou.example.com', origin: 'https://lou.example.com', authorization: basic('a-long-test-password') })).toBe(200);
    expect(await rawCall(url, 'GET', '/api/runs', { host: 'evil.example.com', authorization: basic('a-long-test-password') })).toBe(403);
    // A peer on the internet must get the public https address of this Tuloy, not the address inside the server.
    const card = (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as { supportedInterfaces: { url: string }[] };
    expect(card.supportedInterfaces[0]!.url).toBe('https://lou.example.com/a2a');
    const invite = await new Promise<string>((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: new URL(url).port, method: 'POST', path: '/api/invites', headers: { host: 'lou.example.com', authorization: basic('a-long-test-password') } }, (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk)).on('end', () => resolve(text));
      });
      request.on('error', reject);
      request.end();
    });
    expect((JSON.parse(invite) as { link: string }).link).toMatch(/^https:\/\/lou\.example\.com\/invite\/[\w-]+$/);
    // A peer needs no password of the page: its key is the proof.
    expect(await rawCall(url, 'GET', '/.well-known/agent-card.json', { host: 'lou.example.com' })).toBe(200);
    // The A2A endpoint refuses a call with no key by itself. It does not ask for the password of the page.
    const peerCall = await fetch(`${url}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(peerCall.headers.get('www-authenticate') ?? '').not.toContain('realm="Tuloy"');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('with no password, a Tuloy on this machine works as before', async () => {
  const { server, url } = await startTestServer();
  try {
    expect(await rawCall(url, 'GET', '/api/runs', { host: new URL(url).host })).toBe(200);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- A Tuloy that everybody may look at: a reader sees the runs, and only the owner, with the password, can change something ----

test('with public read, a reader with no password sees the Runs page and the runs; each change, the peers and the injections still need the password', async () => {
  const { server, url, conductor } = await startTestServer({ password: 'a-long-test-password', publicRead: true, demo: true });
  const owner = { authorization: `Basic ${Buffer.from('owner:a-long-test-password').toString('base64')}` };
  try {
    const { runId } = conductor.startRun('A goal of the owner.');
    // A reader: the page, its files, the list of runs, one run, the live events.
    for (const path of ['/', '/page/app.ts', '/page/style.css', '/vendor/three.module.js', '/api/runs', `/api/runs/${runId}`]) expect([path, (await fetch(url + path)).status]).toEqual([path, 200]);
    const stream = await fetch(`${url}/api/events`);
    expect(stream.status).toBe(200);
    await stream.body!.cancel();
    // A reader does not get the controls of demo mode, and the page knows that nobody is signed in.
    expect(await (await fetch(`${url}/api/runs`)).json()).toMatchObject({ demo: false, signedIn: false, publicRead: true });
    // A reader cannot change something, and cannot read the peers or the injections.
    for (const [method, path] of [['POST', '/api/runs'], ['POST', '/api/injections'], ['DELETE', '/api/injections'], ['GET', '/api/injections'], ['GET', '/api/peers'], ['POST', '/api/invites'], ['GET', '/peers']] as const) {
      expect([method, path, (await fetch(url + path, { method })).status]).toEqual([method, path, 401]);
    }
    // A refused call of the page's API does not make the browser ask a reader for a password. The sign-in address does.
    expect((await fetch(`${url}/api/runs`, { method: 'POST' })).headers.get('www-authenticate')).toBeNull();
    expect((await fetch(`${url}/signin`)).headers.get('www-authenticate')).toContain('Basic');
    // The owner signs in at /signin, goes back to the page, and has the controls of demo mode.
    const signedIn = await fetch(`${url}/signin`, { headers: owner, redirect: 'manual' });
    expect([signedIn.status, signedIn.headers.get('location')]).toEqual([302, '/']);
    expect(await (await fetch(`${url}/api/runs`, { headers: owner })).json()).toMatchObject({ demo: true, signedIn: true });
    expect((await fetch(`${url}/api/runs`, { method: 'POST', headers: owner })).status).toBe(201);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('with no public read, a reader with no password still sees nothing', async () => {
  const { server, url } = await startTestServer({ password: 'a-long-test-password' });
  try {
    for (const path of ['/', '/api/runs', '/api/events']) expect([path, (await fetch(url + path)).status]).toEqual([path, 401]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
