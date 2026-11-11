import { createHash, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { AGENT_CARD_PATH, A2A_VERSION_HEADER, AgentCard, Message, Task, TaskState } from '@a2a-js/sdk';
import { AgentEvent, type AgentExecutor, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server';
import { z } from 'zod';
import { createAllowedList, readJson } from './allowed-list.ts';
import type { Conductor } from './conductor.ts';
import { skills, type Skill } from './schemas.ts';
import type { Store } from './store.ts';

const skillNames = Object.keys(skills) as [Skill, ...Skill[]];

const skillWords: Record<Skill, string> = {
  trend_scout: 'Finds the short-video trends that fit a goal.',
  script: 'Writes short-video scripts that use the trends of a goal.',
  reviewer: 'Passes or rejects each script against written criteria.',
  scheduler: 'Makes a posting schedule in Manila time for the scripts that passed.',
  goal: 'Takes a full goal: this Tuloy does a full run and returns the scripts and the posting schedule.',
};

/** What a peer sends, as the JSON text of one A2A message. The result comes back as the JSON text of one artifact. */
const peerMessage = z.object({ skill: z.enum(skillNames), input: z.unknown() });
const HOW_TO_SEND = 'Send JSON text: { "skill": "<skill id>", "input": { ... } }. The agent card lists the skills: one for each agent role, and "goal" for a full goal.';

const digest = (key: string) => createHash('sha256').update(key).digest();

/**
 * The peer server: the allowed list API, the agent card and the A2A endpoint of one Tuloy.
 * `handle` answers false when the request is not for it.
 */
export function createPeerServer({ store, conductor, owner, peerTasksPerHour, allowLocal }: { store: Store; conductor: Conductor; owner: string; peerTasksPerHour: number; allowLocal: boolean }) {
  const card = (address: string) =>
    AgentCard.fromJSON({
      name: `Tuloy of ${owner}`,
      description: `The agents and the conductor of ${owner}'s Tuloy. One task for one agent role, or a full goal. ${HOW_TO_SEND}`,
      version: '1.0.0',
      supportedInterfaces: [{ url: `${address}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: skillNames.map((skill) => ({ id: skill, name: skill === 'goal' ? 'full goal' : skill.replace('_', ' '), description: skillWords[skill], tags: ['tuloy'] })),
      securitySchemes: { key: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { key: { list: [] } } }],
    });

  /** The run of each A2A task that is in work, so that a cancel can stop it. `cancel` is what the cancel says in the event log. */
  const inWork = new Map<string, { runId: number; contextId: string; cancel: string }>();
  const cancelled = new Set<string>();

  /** The agent of one A2A task. The SDK keeps the A2A task; the work itself is a run of one task in the store. */
  const executor: AgentExecutor = {
    async execute(context, bus) {
      const peer = context.context.user!.userName;
      const ids = { taskId: context.taskId, contextId: context.contextId };
      const status = (state: keyof typeof TaskState, words?: string) => ({
        state,
        message: words ? { messageId: crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: words }], ...ids } : undefined,
      });
      /** The first event of each A2A task is the task itself. */
      const begin = (state: keyof typeof TaskState, words?: string) =>
        bus.publish(AgentEvent.task(Task.fromJSON({ id: ids.taskId, contextId: ids.contextId, status: status(state, words) })));

      const text = context.userMessage.parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {}
      const message = peerMessage.safeParse(json);
      if (!message.success) return begin('TASK_STATE_REJECTED', HOW_TO_SEND);
      const role = message.data.skill;
      const input = skills[role].input.safeParse(message.data.input);
      if (!input.success) return begin('TASK_STATE_REJECTED', `The input does not match the input schema of the ${role === 'goal' ? 'goal skill' : `${role} agent`}: ${z.prettifyError(input.error)}`);
      if (store.peerRunsInLastHour(peer) >= peerTasksPerHour) return begin('TASK_STATE_REJECTED', `${peer} is at the limit of ${peerTasksPerHour} tasks per hour.`);

      begin('TASK_STATE_WORKING');
      const update = (state: keyof typeof TaskState, words?: string) =>
        bus.publish(AgentEvent.statusUpdate({ ...ids, status: Task.fromJSON({ status: status(state, words) }).status, metadata: undefined }));
      let output: unknown;
      if (role === 'goal') {
        // A full goal starts a run, and the A2A task follows that run. The result is the scripts and the schedule of the run's tasks.
        const { runId, ended } = conductor.startRun(input.data.goal, peer);
        inWork.set(ids.taskId, { runId, contextId: ids.contextId, cancel: `${peer} cancelled the goal` });
        await ended;
        if (stopped(ids.taskId)) return;
        const run = skills.goal.output.safeParse(Object.assign({}, ...store.tasks(runId).map((t) => t.output)));
        if (store.run(runId)?.status !== 'done' || !run.success) return update('TASK_STATE_FAILED', `${owner}'s Tuloy did not finish the goal: the run ended as ${store.run(runId)?.status}.`);
        output = run.data;
      } else {
        const { runId, ended } = conductor.startPeerTask(peer, role, input.data);
        inWork.set(ids.taskId, { runId, contextId: ids.contextId, cancel: `${peer} cancelled the task` });
        await ended;
        if (stopped(ids.taskId)) return;
        const [task] = store.tasks(runId);
        if (task?.status !== 'done') return update('TASK_STATE_FAILED', `The ${role} agent did not finish the task: ${task?.status}.`);
        output = task.output;
      }
      bus.publish(
        AgentEvent.artifactUpdate({
          ...ids,
          artifact: { artifactId: 'output', name: `${role} output`, description: '', parts: Message.fromJSON({ parts: [{ text: JSON.stringify(output) }] }).parts, metadata: undefined, extensions: [] },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );
      update('TASK_STATE_COMPLETED');
    },
    // The peer that asked gave up (its time limit ended): the run for it stops, so that it spends no more model calls.
    async cancelTask(taskId, bus) {
      const work = inWork.get(taskId);
      if (!work) return;
      cancelled.add(taskId);
      conductor.cancelRun(work.runId, work.cancel);
      bus.publish(AgentEvent.statusUpdate({ taskId, contextId: work.contextId, status: Task.fromJSON({ status: { state: 'TASK_STATE_CANCELED' } }).status, metadata: undefined }));
    },
  };
  /** True when the A2A task was cancelled: it has its last state already. Either way the task is not in work now. */
  const stopped = (taskId: string) => (inWork.delete(taskId), cancelled.delete(taskId));

  const allowedList = createAllowedList({ store, owner, peerTasksPerHour, allowLocal });
  let a2a: { card: AgentCard; transport: JsonRpcTransportHandler } | undefined;

  return {
    async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
      const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      const path = new URL(req.url ?? '/', 'http://tuloy').pathname;
      if (await allowedList.handle(req, res)) return true;
      // ponytail: the address is the loopback socket of the first request. A public address needs a setting.
      a2a ??= (() => {
        const made = card(`http://${req.socket.localAddress}:${req.socket.localPort}`);
        return { card: made, transport: new JsonRpcTransportHandler(new DefaultRequestHandler(made, new InMemoryTaskStore(), executor)) };
      })();

      if (req.method === 'GET' && path === `/${AGENT_CARD_PATH}`) return (json(200, AgentCard.toJSON(a2a.card)), true);

      if (req.method === 'POST' && path === '/a2a') {
        // The key is the proof of who sends. Only a key from the allowed list gets past this line.
        const key = digest(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '');
        const peer = store.peers().find((p) => timingSafeEqual(digest(p.acceptKey), key));
        if (!peer) return (json(401, { error: 'this Tuloy takes work only from its allowed list' }), true);
        const body = await readJson(req);
        try {
          const context = new ServerCallContext({ user: { isAuthenticated: true, userName: peer.name }, requestedVersion: [req.headers[A2A_VERSION_HEADER.toLowerCase()]].flat()[0] });
          validateVersion(context.requestedVersion, a2a.card, 'JSONRPC');
          const answer = await a2a.transport.handle(body as Record<string, unknown>, context);
          // Streaming is off in the card: a stream answer holds only the SDK's error.
          json(200, Symbol.asyncIterator in answer ? (await answer.next()).value : answer);
        } catch (error) {
          json(200, { jsonrpc: '2.0', id: null, error: JsonRpcTransportHandler.mapToJSONRPCError(error) });
        }
        return true;
      }
      return false;
    },
  };
}
