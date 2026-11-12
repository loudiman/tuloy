import dns from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import {
  AgentCard,
  Message,
  type Part,
  Role,
  type Task,
  TaskState,
} from "@a2a-js/sdk";
import {
  type Client,
  ClientFactory,
  JsonRpcTransportFactory,
  type RequestOptions,
} from "@a2a-js/sdk/client";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * The peer client: the one module that sends work to a peer or an outside agent, over A2A (`@a2a-js/sdk`).
 * Copied from Herminie's A2A client, with its guards. Three moves: send words, read where a task stands,
 * cancel a task. Each takes the address and the key from its caller and never throws: every outcome is an
 * answer in our words, never in A2A's.
 *
 * The address and the key arrive from the caller (the allowed list), so the agent card is never fetched:
 * a card could name a send address nobody allowed.
 *
 * Three things it guards:
 * - The address, before each call: https only, no private, loopback, link-local or metadata range, for IPv4
 *   and IPv6. A literal host is checked up front. A name is checked in the connection's own lookup, so a name
 *   that resolves one way for a check and another way for the call has no gap to use. That lookup needs
 *   undici's `connect` option, which the global fetch lacks. No redirects, and no connection is reused, so
 *   each call passes it.
 * - The key: it travels only in the Authorization header. Every failure text here is ours, never the SDK's or
 *   the network's, because those can carry request detail, and a reply that repeats the key has it removed.
 *   Nothing here logs.
 * - The size: a reply is cut at `A2A_REPLY_MAX_CHARS`. The read of the body stops at `A2A_BODY_MAX_BYTES`, so
 *   a huge answer cannot fill memory. A cut JSON body cannot be parsed, so a body past that limit fails instead.
 *
 * The one change from Herminie: `createPeerClient({ allowLocal: true })` (the setting `TULOY_PEER_ALLOW_LOCAL=1`)
 * permits plain http to this same machine (127.0.0.1, [::1], localhost), for two Tuloys on one laptop.
 * It is off by default, and it opens nothing but loopback.
 */

/** Where a reply is cut. About three pages of words. */
export const A2A_REPLY_MAX_CHARS = 16_000;

/**
 * Where the read of a body stops. Wider than the reply, because JSON can spend
 * six bytes on one character, and an agent may ignore the ask for no history.
 */
export const A2A_BODY_MAX_BYTES = 16 * A2A_REPLY_MAX_CHARS;

/** How long one call may take, from connect to the last byte. */
const A2A_CALL_TIMEOUT_MS = 30_000;

/**
 * Why a call ended as failed. `unreachable` alone may clear up, so a wait keeps
 * reading through it until its ceiling. The others are final.
 */
export type A2aFailure =
  | "agent-failed"
  | "sign-in"
  | "key"
  | "address"
  | "redirect"
  | "too-large"
  | "unreachable"
  | "bad-answer";

/** Null when the outside agent gave no task, or the call never reached it. */
interface A2aIds {
  taskId: string | null;
  contextId: string | null;
}

/**
 * The five outcomes. A2A's
 * `FAILED`, `AUTH_REQUIRED` and every failure of the call are `failed`.
 * `CANCELED` is a `result`. No answer before the
 * task's life ends stays `progress`: that ceiling is the caller's wait.
 */
export type A2aAnswer = A2aIds &
  (
    | { status: "progress"; text?: string }
    | { status: "ask" | "result" | "refused"; text: string }
    | { status: "failed"; failure: A2aFailure; text: string }
  );

export interface A2aCall {
  address: string;
  key: string;
}

/** `taskId` and `contextId` continue a task that asked a question. */
export interface A2aSend extends A2aCall {
  /** The call id: the A2A message id, so a repeat is the same message. */
  callId: string;
  text: string;
  taskId?: string;
  contextId?: string;
}

export interface A2aTaskCall extends A2aCall {
  taskId: string;
}

export interface A2aClient {
  send(call: A2aSend): Promise<A2aAnswer>;
  read(call: A2aTaskCall): Promise<A2aAnswer>;
  cancel(call: A2aTaskCall): Promise<A2aAnswer>;
}

/** Stops a call with our own words. */
export class A2aStop extends Error {
  readonly failure: A2aFailure;
  constructor(failure: A2aFailure, text: string) {
    super(text);
    this.failure = failure;
  }
}

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // shared space; holds one cloud's metadata address
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local; holds the usual metadata address
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3], // multicast, reserved, broadcast
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local; holds one cloud's metadata address
  ["fe80::", 10], // link-local
  ["fec0::", 10],
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv6");
}

/** IPv4 in IPv6 clothes (`::ffff:a.b.c.d`) meets the IPv4 rules: BlockList does that. */
export function isBlockedIp(ip: string): boolean {
  return BLOCKED.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** Why this address may not be called, or null. */
function addressProblem(address: string, allowLocal: boolean): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "it is not an address";
  }
  if (url.username || url.password) return "it holds a name or a password";
  if (allowLocal && LOCAL_HOSTS.has(url.hostname)) return null;
  if (url.protocol !== "https:") return "it is not https";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return isIP(host) && isBlockedIp(host)
    ? "it points at a private or local range"
    : null;
}

const stopOf = (error: unknown): A2aStop => {
  if (error instanceof A2aStop) return error;
  const cause = (error as Error).cause as Error | undefined;
  if (cause instanceof A2aStop) return cause;
  // ponytail: undici's words, the only mark it gives. If they change, a
  // redirect reads as unreachable and `tests/peer-client.test.ts` fails.
  return cause?.message === "unexpected redirect"
    ? new A2aStop(
        "redirect",
        "The outside agent's address redirects, and a redirect is not followed.",
      )
    : new A2aStop("unreachable", "The outside agent could not be reached.");
};

async function cappedBody(body: AsyncIterable<Uint8Array> | Uint8Array[]) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > A2A_BODY_MAX_BYTES) {
      throw new A2aStop(
        "too-large",
        `The outside agent's reply is larger than ${A2A_BODY_MAX_BYTES} bytes, so it was not read.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Only text and links come through, cut at the limit, with the key removed. */
function replyText(parts: Part[], key: string): string {
  const kept: string[] = [];
  let dropped = 0;
  for (const { content } of parts) {
    if (content?.$case === "text") kept.push(content.value);
    else if (content?.$case === "url" && /^https?:\/\//i.test(content.value)) {
      kept.push(content.value);
    } else dropped += 1;
  }
  // A NUL or half a surrogate pair would fail the row that stores the reply.
  const whole = kept.join("\n").replaceAll(key, "[key]").replaceAll("\0", "");
  const count = dropped === 1 ? "1 part was" : `${dropped} parts were`;
  return [
    whole.slice(0, A2A_REPLY_MAX_CHARS).toWellFormed(),
    whole.length > A2A_REPLY_MAX_CHARS &&
      `[The reply was cut at ${A2A_REPLY_MAX_CHARS} characters.]`,
    dropped > 0 && `[${count} dropped: only text and links come through.]`,
  ]
    .filter(Boolean)
    .join("\n");
}

function answerOf(reply: Message | Task, key: string): A2aAnswer {
  if ("messageId" in reply) {
    return {
      status: "result",
      text: replyText(reply.parts, key) || "The outside agent sent no words.",
      taskId: reply.taskId || null,
      contextId: reply.contextId || null,
    };
  }
  const ids = { taskId: reply.id, contextId: reply.contextId };
  const text = replyText(
    [
      ...(reply.status?.message?.parts ?? []),
      ...reply.artifacts.flatMap((artifact) => artifact.parts),
    ],
    key,
  );
  switch (reply.status?.state) {
    case TaskState.TASK_STATE_SUBMITTED:
    case TaskState.TASK_STATE_WORKING:
      // The words of a task in work: a Tuloy puts its progress there.
      return { status: "progress", ...(text && { text }), ...ids };
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return {
        status: "ask",
        text:
          text || "The outside agent wants more, and asked nothing in words.",
        ...ids,
      };
    case TaskState.TASK_STATE_COMPLETED:
      return {
        status: "result",
        text: text || "The outside agent finished and sent no words.",
        ...ids,
      };
    case TaskState.TASK_STATE_CANCELED:
      return {
        status: "result",
        text: text || "The outside agent canceled the task.",
        ...ids,
      };
    case TaskState.TASK_STATE_REJECTED:
      return {
        status: "refused",
        text: text || "The outside agent refused and gave no reason.",
        ...ids,
      };
    case TaskState.TASK_STATE_FAILED:
      return {
        status: "failed",
        failure: "agent-failed",
        text: text || "The outside agent failed and gave no reason.",
        ...ids,
      };
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return {
        status: "failed",
        failure: "sign-in",
        text: [
          "The outside agent needs a sign-in that Tuloy does not have.",
          ...(text ? [`It said: ${text}`] : []),
        ].join(" "),
        ...ids,
      };
    default:
      throw new Error("no state we know");
  }
}

const failed = (failure: A2aFailure, text: string): A2aAnswer => ({
  status: "failed",
  failure,
  text,
  taskId: null,
  contextId: null,
});

/**
 * A fetch with the address guard, for every call that goes to another owner's
 * address: the A2A moves, the answer to an invite, and the read of an agent card.
 * It refuses an address that is not https or that points at a private or local
 * range, checks the name again in the connection's own lookup, and follows no
 * redirect. A refusal is an `A2aStop` with the failure `address`.
 */
export function createPeerFetch({ allowLocal = false }: { allowLocal?: boolean } = {}) {
  /** Runs for each connection to a name, so the checked address is the one used. */
  const guardedLookup: LookupFunction = (host, options, done) => {
    dns.lookup(host, { ...options, all: true }, (error, addresses) => {
      if (error) return done(error, "");
      if (
        !(allowLocal && LOCAL_HOSTS.has(host)) &&
        addresses.some(({ address }) => isBlockedIp(address))
      ) {
        return done(
          new A2aStop(
            "address",
            "The outside agent's address is refused: its name resolves to a private or local range.",
          ),
          "",
        );
      }
      if (options.all) return done(null, addresses);
      done(null, addresses[0]!.address, addresses[0]!.family);
    });
  };

  /** `pipelining: 0` closes each connection, so each call passes the lookup. */
  const dispatcher = new Agent({
    connect: { lookup: guardedLookup },
    pipelining: 0,
  });

  return (async (input: string, init: object = {}) => {
    try {
      const problem = addressProblem(input, allowLocal);
      if (problem) throw new A2aStop("address", `The address is refused: ${problem}.`);
      return await undiciFetch(input, { ...init, dispatcher, redirect: "error" });
    } catch (error) {
      throw stopOf(error);
    }
  }) as unknown as (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * The real client. Each move runs its own SDK client, so no call shares state.
 * `allowLocal` permits plain http to this same machine; it is off by default.
 */
export function createPeerClient({ allowLocal = false }: { allowLocal?: boolean } = {}): A2aClient {
  const peerFetch = createPeerFetch({ allowLocal });

  const guardedFetch = (async (input: string, init: RequestInit) => {
    try {
      const response = await peerFetch(input, {
        ...init,
        signal: AbortSignal.timeout(A2A_CALL_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new A2aStop("key", "The outside agent refused the key.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new A2aStop("unreachable", "The outside agent could not answer.");
      }
      return new Response(await cappedBody(response.body ?? []), {
        status: response.status,
      });
    } catch (error) {
      throw stopOf(error);
    }
  }) as typeof fetch;

  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: guardedFetch })],
  });

  /** The guard, the key and the words around one move. */
  async function move(
    { address, key }: A2aCall,
    run: (client: Client, options: RequestOptions) => Promise<Message | Task>,
  ): Promise<A2aAnswer> {
    const problem = addressProblem(address, allowLocal);
    if (problem) {
      return failed(
        "address",
        `The outside agent's address is refused: ${problem}.`,
      );
    }
    if (!key) return failed("key", "The outside agent has no key.");
    try {
      const card = AgentCard.fromJSON({
        supportedInterfaces: [
          { url: address, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
      });
      const client = await factory.createFromAgentCard(card);
      const serviceParameters = { Authorization: `Bearer ${key}` };
      return answerOf(await run(client, { serviceParameters }), key);
    } catch (error) {
      return error instanceof A2aStop
        ? failed(error.failure, error.message)
        : failed(
            "bad-answer",
            "The outside agent answered with an error, or with something that is not A2A.",
          );
    }
  }

  return {
    send: (call) =>
      move(call, (client, options) =>
        client.sendMessage(
          {
            tenant: "",
            metadata: undefined,
            message: Message.fromJSON({
              messageId: call.callId,
              role: Role.ROLE_USER,
              parts: [{ text: call.text }],
              taskId: call.taskId,
              contextId: call.contextId,
            }),
            configuration: {
              acceptedOutputModes: [],
              taskPushNotificationConfig: undefined,
              historyLength: 0,
              returnImmediately: true,
            },
          },
          options,
        ),
      ),
    read: (call) =>
      move(call, (client, options) =>
        client.getTask(
          { tenant: "", id: call.taskId, historyLength: 0 },
          options,
        ),
      ),
    cancel: (call) =>
      move(call, (client, options) =>
        client.cancelTask(
          { tenant: "", id: call.taskId, metadata: undefined },
          options,
        ),
      ),
  };
}

/**
 * A client for tests of what calls this one. It plays `answers` in order and
 * repeats the last, so one `progress` is a silent outside agent. `calls` holds
 * each move.
 */
export function fakeA2a(answers: A2aAnswer[]) {
  const left = [...answers];
  const calls: Array<{ move: keyof A2aClient; call: A2aCall }> = [];
  const play = (name: keyof A2aClient) => async (call: A2aCall) => {
    calls.push({ move: name, call });
    return left.length > 1 ? left.shift()! : left[0]!;
  };
  return {
    calls,
    send: play("send"),
    read: play("read"),
    cancel: play("cancel"),
  } satisfies A2aClient & { calls: unknown };
}
