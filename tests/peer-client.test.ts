import assert from "node:assert/strict";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { once } from "node:events";
import { afterAll as after, afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  A2A_BODY_MAX_BYTES,
  A2A_REPLY_MAX_CHARS,
  createPeerClient,
  type A2aAnswer,
  fakeA2a,
  isBlockedIp,
} from "../src/peer-client.ts";

/**
 * The peer client against recorded wire answers. Copied from Herminie's tests of its A2A client, with the
 * recordings of its Python test partner. A small local server replays them, so the real SDK and the real
 * fetch run, with no model. Only the JSON-RPC id is rewritten, because each move here is a fresh client.
 */

const RECORDINGS = join(import.meta.dirname, "fixtures", "a2a");
const FIXTURES = RECORDINGS;
const KEY = "test-key-that-must-never-leak";

/** `local` has the same-machine setting on, as the two-Tuloy demo has it. `guarded` is the default. */
const local = createPeerClient({ allowLocal: true });
const guarded = createPeerClient();
let a2aClient = local;

interface Exchange {
  request: { body: { method: string; params?: Record<string, unknown> } };
  status: number;
  response: Record<string, unknown>;
}

const recording = (name: string, dir = RECORDINGS): Exchange[] =>
  (
    JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as {
      exchanges: Exchange[];
    }
  ).exchanges;

interface Seen {
  headers: IncomingMessage["headers"];
  body: { id: number; method: string; params: Record<string, any> };
}

const servers: Server[] = [];

/** A local server on a free port, closed after the test. */
async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a`;
}

async function bodyOf(req: IncomingMessage): Promise<Seen["body"]> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

/** Answers each call with the next exchange, and keeps what it was sent. */
async function replay(exchanges: Exchange[]) {
  const seen: Seen[] = [];
  const queue = [...exchanges];
  const address = await serve(async (req, res) => {
    const body = await bodyOf(req);
    seen.push({ headers: req.headers, body });
    const next = queue.shift();
    if (!next) throw new Error(`no exchange left for ${body.method}`);
    assert.equal(body.method, next.request.body.method);
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        "jsonrpc" in next.response
          ? { ...next.response, id: body.id }
          : next.response,
      ),
    );
  });
  return { address, seen };
}

/** A completed task whose status message says `text`. */
const completedWith = (text: string, id = 1) => ({
  jsonrpc: "2.0",
  id,
  result: {
    id: "task-1",
    contextId: "context-1",
    status: {
      state: "TASK_STATE_COMPLETED",
      message: {
        messageId: "m-1",
        role: "ROLE_AGENT",
        parts: [{ text }],
      },
    },
  },
});

const ids = { taskId: "id-1", contextId: "id-2" };
const noIds = { taskId: null, contextId: null };

const sendFor = (address: string, caseName: string, text: string) =>
  a2aClient.send({
    address,
    key: KEY,
    callId: `message-${caseName}-1`,
    text,
  });

const read = (address: string, taskId = "id-1") =>
  a2aClient.read({ address, key: KEY, taskId });

beforeEach(() => {
  a2aClient = local;
});

afterEach(() => {
  vi.restoreAllMocks();
});

after(() => {
  for (const server of servers) server.closeAllConnections();
  for (const server of servers) server.close();
});

describe("the states table, against the recordings", () => {
  const ended = (
    name: string,
    text: string,
    expected: Partial<A2aAnswer> & { status: A2aAnswer["status"] },
  ) =>
    it(`${name}: send gives progress, read gives ${expected.status}`, async () => {
      const exchanges = recording(name);
      const { address, seen } = await replay(exchanges);
      assert.deepEqual(await sendFor(address, name, text), {
        status: "progress",
        ...ids,
      });
      assert.deepEqual(await read(address), { ...expected, ...ids });

      const [send, get] = seen;
      assert.equal(send!.headers["a2a-version"], "1.0");
      assert.equal(send!.headers.authorization, `Bearer ${KEY}`);
      assert.deepEqual(
        send!.body.params.message,
        exchanges[0]!.request.body.params!.message,
      );
      assert.equal(send!.body.params.configuration.returnImmediately, true);
      assert.equal(get!.headers["a2a-version"], "1.0");
      assert.equal(get!.headers.authorization, `Bearer ${KEY}`);
      assert.equal(get!.body.params.id, "id-1");
    });

  ended("completed", "times", {
    status: "result",
    text: "Free times: Tuesday 10:00 and Wednesday 14:30.",
  });
  ended("rejected", "refuse", {
    status: "refused",
    text: "I do not take meeting requests from this sender.",
  });
  ended("failed", "fail", {
    status: "failed",
    failure: "agent-failed",
    text: "The calendar service is down.",
  });
  ended("auth-required", "auth", {
    status: "failed",
    failure: "sign-in",
    text: "The outside agent needs a sign-in that Tuloy does not have. It said: Sign in to the booking portal first.",
  });

  it("input-required: a question is an ask, and the answer continues the same task", async () => {
    const exchanges = recording("input-required");
    const { address, seen } = await replay(exchanges);
    await sendFor(address, "input-required", "question");
    assert.deepEqual(await read(address), {
      status: "ask",
      text: "Which day suits you best?",
      ...ids,
    });
    assert.deepEqual(
      await a2aClient.send({
        address,
        key: KEY,
        callId: "message-input-required-2",
        text: "Tuesday",
        ...ids,
      }),
      { status: "result", text: "Thanks. Booked for Tuesday.", ...ids },
    );
    assert.deepEqual(await read(address), {
      status: "result",
      text: "Thanks. Booked for Tuesday.",
      ...ids,
    });
    assert.deepEqual(
      seen[2]!.body.params.message,
      exchanges[2]!.request.body.params!.message,
    );
  });

  it("silent: no answer stays progress, so the wait's ceiling decides", async () => {
    const { address } = await replay(recording("silent"));
    const working = { status: "progress", ...ids };
    assert.deepEqual(await sendFor(address, "silent", "silent"), working);
    assert.deepEqual(await read(address), working);
  });

  it("canceled: a cancel ends the step", async () => {
    const { address, seen } = await replay(recording("canceled"));
    await sendFor(address, "canceled", "cancel");
    assert.equal((await read(address)).status, "progress");
    const canceled = {
      status: "result",
      text: "The outside agent canceled the task.",
      ...ids,
    };
    assert.deepEqual(
      await a2aClient.cancel({ address, key: KEY, taskId: "id-1" }),
      canceled,
    );
    assert.deepEqual(await read(address), canceled);
    assert.equal(seen[2]!.body.method, "CancelTask");
    assert.equal(seen[2]!.headers["a2a-version"], "1.0");
    assert.equal(seen[2]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(seen[2]!.body.params.id, "id-1");
  });

  it("wrong-key: a refused key is a clear failure", async () => {
    const { address } = await replay(recording("wrong-key"));
    assert.deepEqual(await sendFor(address, "wrong-key", "times"), {
      status: "failed",
      failure: "key",
      text: "The outside agent refused the key.",
      ...noIds,
    });
  });
});

describe("where a reply's text sits", () => {
  it("reads artifacts after the status message, keeps links, and says what it dropped", async () => {
    const { address } = await replay(recording("artifact-answer", FIXTURES));
    assert.deepEqual(await read(address, "task-artifact"), {
      status: "result",
      text: [
        "The times are in the artifact.",
        "Free times: Friday 09:00.",
        "https://partner.example/times.ics",
        "[3 parts were dropped: only text and links come through.]",
      ].join("\n"),
      taskId: "task-artifact",
      contextId: "context-artifact",
    });
  });

  it("takes a plain Message as a result with no task", async () => {
    const { address } = await replay(recording("message-answer", FIXTURES));
    assert.deepEqual(await sendFor(address, "message", "times"), {
      status: "result",
      text: "Friday 09:00 is free.",
      taskId: null,
      contextId: "context-message",
    });
  });
});

describe("size limits", () => {
  it("cuts a long reply at the limit, says so, and keeps the text well formed", async () => {
    const emojiAtTheCut = `${"a".repeat(A2A_REPLY_MAX_CHARS - 1)}😀 and more`;
    const { address } = await replay([
      {
        request: { body: { method: "GetTask" } },
        status: 200,
        response: completedWith(emojiAtTheCut),
      },
    ]);
    const answer = await read(address, "task-1");
    assert.equal(answer.status, "result");
    if (answer.status !== "result") return;
    const line = `[The reply was cut at ${A2A_REPLY_MAX_CHARS} characters.]`;
    assert.ok(answer.text.endsWith(`\n${line}`));
    assert.equal(answer.text.length, A2A_REPLY_MAX_CHARS + 1 + line.length);
    assert.ok(answer.text.isWellFormed());
  });

  it("stops reading an endless body and gives a clear failure", async () => {
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, "x");
    const address = await serve(async (req, res) => {
      await bodyOf(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.on("close", () => res.destroy());
      while (!res.destroyed) {
        sent += chunk.length;
        if (!res.write(chunk)) {
          await Promise.race([once(res, "drain"), once(res, "close")]);
        }
      }
    });
    assert.deepEqual(await read(address, "task-1"), {
      status: "failed",
      failure: "too-large",
      text: `The outside agent's reply is larger than ${A2A_BODY_MAX_BYTES} bytes, so it was not read.`,
      ...noIds,
    });
    // Socket buffers hold some, so the bound is loose. An unbounded read
    // never reaches this line.
    assert.ok(sent < 64 * A2A_BODY_MAX_BYTES, `sent ${sent} bytes`);
  });
});

describe("the address guard", () => {
  const refused = (address: string) =>
    a2aClient.read({ address, key: KEY, taskId: "t" });

  beforeEach(() => {
    a2aClient = guarded;
  });

  for (const address of [
    "not an address",
    "http://partner.example/a2a",
    "ftp://partner.example/a2a",
    "https://user:password@partner.example/a2a",
    "https://127.0.0.1/a2a",
    "https://2130706433/a2a",
    "https://0x7f.1/a2a",
    "https://10.1.2.3/a2a",
    "https://172.16.0.1/a2a",
    "https://192.168.1.1/a2a",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/a2a",
    "https://[fe80::1]/a2a",
    "https://[fd00:ec2::254]/a2a",
    "https://[::ffff:127.0.0.1]/a2a",
    "https://[::ffff:169.254.169.254]/a2a",
    "http://127.0.0.1:4310/a2a",
  ]) {
    it(`refuses ${address}`, async () => {
      const answer = await refused(address);
      assert.equal(answer.status, "failed");
      assert.equal(answer.status === "failed" && answer.failure, "address");
    });
  }

  const resolvesTo = (...addresses: string[]) =>
    vi.spyOn(dns, "lookup").mockImplementation(((
      _host: string,
      _options: object,
      done: (error: null, found: dns.LookupAddress[]) => void,
    ) => {
      const family = (address: string) => (address.includes(":") ? 6 : 4);
      done(
        null,
        addresses.map((address) => ({ address, family: family(address) })),
      );
    }) as unknown as typeof dns.lookup);

  for (const resolved of [
    ["10.0.0.1"],
    ["169.254.169.254"],
    ["::1"],
    ["fe80::1"],
    ["::ffff:10.0.0.1"],
    ["8.8.8.8", "127.0.0.1"],
  ]) {
    it(`refuses a name that resolves to ${resolved.join(" and ")}`, async () => {
      const lookup = resolvesTo(...resolved);
      const answer = await refused("https://partner.example/a2a");
      assert.equal(answer.status, "failed");
      assert.equal(answer.status === "failed" && answer.failure, "address");
      assert.ok(lookup.mock.calls.length > 0);
    });
  }

  it("opens a new connection for each call, so each passes the lookup", async () => {
    a2aClient = local;
    const silent = recording("silent")[1]!;
    const { address, seen } = await replay([silent, silent, silent]);
    let connections = 0;
    servers.at(-1)!.on("connection", () => {
      connections += 1;
    });
    for (let call = 0; call < 3; call += 1) await read(address);
    assert.equal(connections, 3);
    assert.equal(seen[0]!.headers.connection, "close");
  });

  it("refuses localhost over https", async () => {
    resolvesTo("127.0.0.1");
    const answer = await refused("https://localhost/a2a");
    assert.equal(answer.status === "failed" && answer.failure, "address");
  });

  it("knows each range, for IPv4 and IPv6, and lets public addresses through", () => {
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "100.100.100.200",
      "127.0.0.1",
      "169.254.169.254",
      "172.31.255.255",
      "192.0.0.192",
      "192.168.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::127.0.0.1",
      "fc00::1",
      "fd00:ec2::254",
      "fe80::1",
      "fec0::1",
      "ff02::1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2001:db8::1",
      "2002:7f00:1::",
    ]) {
      assert.equal(isBlockedIp(ip), true, ip);
    }
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8",
    ]) {
      assert.equal(isBlockedIp(ip), false, ip);
    }
  });
});

describe("the same-machine setting", () => {
  it("is off by default: a loopback address is refused and nothing is sent", async () => {
    const { address, seen } = await replay(recording("silent"));
    a2aClient = guarded;
    const answer = await read(address);
    assert.equal(answer.status === "failed" && answer.failure, "address");
    assert.equal(seen.length, 0);
  });

  it("reaches a local name when it is on", async () => {
    const { address } = await replay([recording("silent")[1]!]);
    assert.equal(
      (await read(address.replace("127.0.0.1", "localhost"))).status,
      "progress",
    );
  });

  it("opens nothing but loopback", async () => {
    for (const address of [
      "http://10.0.0.1/a2a",
      "http://partner.example/a2a",
      "https://10.0.0.1/a2a",
    ]) {
      const answer = await read(address);
      assert.equal(answer.status === "failed" && answer.failure, "address");
    }
  });
});

describe("other failures", () => {
  it("does not follow a redirect", async () => {
    let calls = 0;
    const target = await serve((_req, res) => {
      calls += 1;
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    });
    assert.deepEqual(await read(target), {
      status: "failed",
      failure: "redirect",
      text: "The outside agent's address redirects, and a redirect is not followed.",
      ...noIds,
    });
    assert.equal(calls, 1);
  });

  it("refuses an empty key before any call", async () => {
    const { address, seen } = await replay(recording("silent"));
    const answer = await a2aClient.read({ address, key: "", taskId: "id-1" });
    assert.equal(answer.status === "failed" && answer.failure, "key");
    assert.equal(seen.length, 0);
  });

  it("calls a 403 a refused key too", async () => {
    const address = await serve((_req, res) => {
      res.writeHead(403);
      res.end();
    });
    const answer = await read(address);
    assert.equal(answer.status === "failed" && answer.failure, "key");
  });

  it("calls a server error unreachable, so a later read can try again", async () => {
    const address = await serve((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const answer = await read(address);
    assert.equal(answer.status === "failed" && answer.failure, "unreachable");
  });

  it("calls a closed port unreachable", async () => {
    const answer = await read("http://127.0.0.1:9/a2a");
    assert.equal(answer.status === "failed" && answer.failure, "unreachable");
  });

  it("calls a JSON-RPC error, a broken body and an unknown state a bad answer", async () => {
    for (const body of [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "Task not found" },
      }),
      "<html>not json</html>",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { id: "t" } }),
    ]) {
      const address = await serve((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
      const answer = await read(address);
      assert.equal(answer.status === "failed" && answer.failure, "bad-answer");
    }
  });
});

describe("the key", () => {
  const echoes = [
    {
      name: "a reply that repeats it",
      status: 200,
      body: () => completedWith(`Your key is ${KEY}.`),
    },
    {
      name: "a JSON-RPC error that repeats it",
      status: 200,
      body: () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: `bad key ${KEY}` },
      }),
    },
    {
      name: "an HTTP error that repeats it",
      status: 500,
      body: () => ({ error: `bad key ${KEY}` }),
    },
  ];

  for (const { name, status, body } of echoes) {
    it(`stays out of the answer and the logs on ${name}`, async () => {
      const logs: string[] = [];
      for (const level of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(" "));
        });
      }
      const address = await serve((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body()));
      });
      const answer = await read(address, "task-1");
      assert.ok(!JSON.stringify(answer).includes(KEY), JSON.stringify(answer));
      assert.ok(!logs.join("\n").includes(KEY));
    });
  }

  it("stays out of the failure when the key is no valid header", async () => {
    const address = await serve((_req, res) => res.end());
    const key = `${KEY}\nnext`;
    const answer = await a2aClient.read({ address, key, taskId: "t" });
    assert.equal(answer.status, "failed");
    assert.ok(!JSON.stringify(answer).includes(KEY));
  });
});

describe("the fake", () => {
  it("plays its answers in order, repeats the last, and keeps the calls", async () => {
    const working = { status: "progress", ...ids } as const;
    const done = { status: "result", text: "Done.", ...ids } as const;
    const fake = fakeA2a([working, done]);
    const call = { address: "https://a.example", key: "k", taskId: "id-1" };
    assert.deepEqual(await fake.read(call), working);
    assert.deepEqual(await fake.read(call), done);
    assert.deepEqual(await fake.cancel(call), done);
    assert.deepEqual(
      fake.calls.map((c) => c.move),
      ["read", "read", "cancel"],
    );
  });
});
