import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { check, type AgentResult, type RunOptions } from './agent-runner.ts';
import type { A2aAnswer, A2aClient } from './peer-client.ts';
import { roles, type Role, type Skill } from './schemas.ts';
import type { Peer } from './store.ts';

/** The name of a peer's agent as the owner reads it: "Maria's script agent". The full goal goes to the peer's conductor. */
export const peerAgentName = (peer: Peer, role: Skill) => (role === 'goal' ? `${peer.name}'s conductor` : `${peer.name}'s ${role.replace('_', ' ')} agent`);

/** The key of the progress in the JSON text of a working status. */
export const PROGRESS_KEY = 'tuloy_progress';
const progressSchema = z.object({
  [PROGRESS_KEY]: z.array(z.object({ role: z.enum(Object.keys(roles) as [Role, ...Role[]]), state: z.enum(['waiting', 'working', 'done', 'blocked']) })).max(8),
});
/** The progress that a peer's Tuloy sends while it has work: which of its agents works and which are done. */
export type PeerProgress = z.infer<typeof progressSchema>[typeof PROGRESS_KEY];

/** The progress in the words of a peer's working status. It is outside data: all that does not match the schema gives null. */
export function readProgress(text: string): PeerProgress | null {
  try {
    return progressSchema.parse(JSON.parse(text))[PROGRESS_KEY];
  } catch {
    return null;
  }
}

/**
 * Step 3 of the recovery order, one attempt: the same role and the same checked input go to the same agent in a peer's Tuloy.
 * Step 4 uses it too: the skill `goal` with the goal as the input goes to the peer's conductor.
 * It sends one A2A message (`{ skill, input }` as JSON text), then polls the A2A task every `heartbeatMs` until the task time limit.
 * Each poll that the peer answers is a heartbeat. The peer's result is checked against the same schema as the owner's agent.
 * `onProgress` gets the checked progress of a peer's Tuloy, each time that an answer has one.
 * It never throws. Every way to no result is a failure: `peer_failed` (refused, failed, a question), `timeout` (the task
 * stays in work until the task time limit), `missed_heartbeat` (the peer stopped answering the polls), `invalid_output` (a bad payload).
 */
export async function runPeerAgent(role: Skill, input: unknown, peer: Peer, client: A2aClient, { clock, limits, onHeartbeat, injected, onProgress }: RunOptions & { onProgress?: (progress: PeerProgress) => void }): Promise<AgentResult> {
  const who = peerAgentName(peer, role);
  const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
  // What the peer said goes into an event: cut it, and never with the key (the client removes it already).
  const said = (text: string) => text.replaceAll(peer.sendKey, '[key]').replace(/\.$/, '').slice(0, 300);
  // `fast`: the peer did not take the task. The conductor may then ask the next peer on the allowed list.
  const fail = (kind: 'peer_failed' | 'timeout' | 'missed_heartbeat', detail: string, fast = false): AgentResult => ({ ok: false, failure: { kind, detail, fast } });
  const call = { address: `${peer.address}/a2a`, key: peer.sendKey };

  // Demo mode: an injected peer gets no call. `peer_refuses` is a refusal at once; `peer_silent` is a task that stays in work.
  if (injected === 'peer_refuses') return fail('peer_failed', `${peer.name} refused the task (demo: injected refusal)`, true);
  const silent: A2aAnswer | null = injected === 'peer_silent' ? { status: 'progress', taskId: 'demo: injected silent peer', contextId: null } : null;

  const started = clock.now();
  let lastBeat = started;
  let answer: A2aAnswer = silent ?? await client.send({ ...call, callId: randomUUID(), text: JSON.stringify({ skill: role, input }) });
  const taskId = answer.taskId;
  let polled = false;
  for (;;) {
    if (answer.status === 'result') {
      let output: unknown;
      try {
        output = JSON.parse(answer.text);
      } catch {}
      return check(role, output);
    }
    if (answer.status === 'refused') return fail('peer_failed', `${peer.name} refused the task: ${said(answer.text)}`, !polled);
    // A poll that did not reach the peer may clear up: the missed-heartbeat time decides. Every other failure is final.
    const noAnswer = answer.status === 'failed' && answer.failure === 'unreachable' && polled;
    if (answer.status === 'failed' && !noAnswer) return fail('peer_failed', `${who} failed: ${said(answer.text)}`, !polled);
    if (answer.status === 'ask') {
      // A run has no person in the loop, so a question ends the step. The peer is told to stop.
      if (taskId) await client.cancel({ ...call, taskId });
      return fail('peer_failed', `${who} asked a question, and a run has nobody to answer it`);
    }
    if (!taskId) return fail('peer_failed', `${who} gave no task to read`);
    const progress = answer.status === 'progress' && answer.text ? readProgress(answer.text) : null;
    if (progress) onProgress?.(progress);
    if (answer.status === 'progress' && polled) {
      lastBeat = clock.now();
      onHeartbeat?.();
    }
    await clock.sleep(Math.min(limits.heartbeatMs, started + limits.taskTimeLimitMs - clock.now()));
    const now = clock.now();
    const stalled =
      now - started >= limits.taskTimeLimitMs
        ? fail('timeout', `${who} gave no result in ${seconds(now - started)}`)
        : now - lastBeat >= limits.heartbeatMissedMs
          ? fail('missed_heartbeat', `${peer.name}'s Tuloy did not answer for ${seconds(now - lastBeat)}`)
          : null;
    if (stalled) {
      if (!silent) await client.cancel({ ...call, taskId }); // nobody waits for the task now
      return stalled;
    }
    answer = silent ?? (await client.read({ ...call, taskId }));
    polled = true;
  }
}
