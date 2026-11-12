import type { Skill } from './schemas.ts';
import type { Run, Task, TuloyEvent } from './store.ts';
import { foundFailure, replay } from './task-view.ts';

/** Who has the work: the owner's own agent, the owner's backup model, a peer's agent (one task), or a peer's conductor (the full goal). */
export type Lane = 'own' | 'backup' | 'peer' | 'peer_goal';

/** One stop of the route: one task of the task graph, with its state now. */
export type TripStop = {
  id: string;
  role: Skill;
  title: string;
  state: 'waiting' | 'working' | 'done' | 'blocked' | 'rejected';
  lane: Lane;
  /** The name of the peer, when the lane is `peer` or `peer_goal`. */
  peer?: string;
  /** The time of the last heartbeat while the stop is working. Null when it is not working, or sent none yet. */
  lastHeartbeat: number | null;
};

/** One step of the trip. It is made from one event, and from the events before it only. */
export type TripStep = {
  /** The `seq` of the event. */
  seq: number;
  kind: 'start' | 'work' | 'done' | 'failure' | 'retry' | 'reroute' | 'rejection' | 'pass' | 'goal_to_peer' | 'injection' | 'restart' | 'end';
  /** The task id of the stop. Null for a step of the whole run. */
  stop: string | null;
  /** The role of the stop's task: which agent. `goal` is the full goal at a peer's conductor. Null for a step of the whole run. */
  role: Skill | null;
  lane: Lane;
  peer?: string;
  /** What the jeepney carries after this step. */
  cargo: string;
  /** The plain sentence. It is the line of the recovery summary when the event has one. */
  text: string;
  tone: 'ok' | 'trouble' | 'recovery' | 'end';
  /** For a failure or a rejection: the short text of the road sign. */
  sign?: string;
  /** For a failure: the kind, for example `timeout`. */
  failure?: string;
  /** For a failure or a rejection: true when the presenter injected it in demo mode. It is not a real failure. */
  injected?: true;
  /** For a retry: retry `retry` of `of`, after a wait of `waitMs`. */
  retry?: number;
  of?: number;
  waitMs?: number;
};

export type Trip = { status: Run['status']; forPeer: string | null; stops: TripStop[]; steps: TripStep[] };

const carriesIn: Record<string, string> = { trend_scout: 'Goal', script: 'Trends', reviewer: 'Scripts', scheduler: 'Review', goal: 'Goal' };
const carriesOut: Record<string, string> = { trend_scout: 'Trends', script: 'Scripts', reviewer: 'Review', scheduler: 'Schedule', goal: 'Scripts and schedule' };
const signs: Record<string, string> = {
  timeout: 'No answer in time',
  missed_heartbeat: 'No heartbeat',
  invalid_output: 'The output is not valid',
  rate_limited: 'The model is rate-limited',
  model_unavailable: 'The model is not available',
  peer_failed: 'The peer did not finish the task',
  rejected: 'Rejected by the reviewer',
};

/**
 * The run as a trip: the stops of the route with their state now, and the steps so far in the order of the events.
 * Pure. More events only add steps: the steps of a part of the events are the start of the steps of all the events.
 * `tasks` are the tasks of every version of the task graph, oldest first (a task id that comes two times: the last one counts).
 * A heartbeat is not a step: it sets `lastHeartbeat` of its stop.
 */
export function tripOf(run: Run, tasks: Task[], events: TuloyEvent[]): Trip {
  const stops = new Map<string, TripStop>(tasks.map((t) => [t.id, { id: t.id, role: t.role, title: t.title, state: 'waiting', lane: t.role === 'goal' ? 'peer_goal' : 'own', lastHeartbeat: null }]));
  const steps: TripStep[] = [];
  const injected = new Set<string>();
  let cargo = 'Goal';
  for (const { event: e, name, who, line } of replay(events)) {
    const id = e.taskId;
    const task = id ? stops.get(id) : undefined;
    // The pass has the script task in its event, but it occurs at the reviewer's stop.
    const stop = e.action === 'review' && e.result === 'pass' ? ([...stops.values()].find((s) => s.role === 'reviewer') ?? task) : task;
    const data = (e.data ?? {}) as { peer?: string; retry?: number; of?: number; waitMs?: number };
    const set = (state: TripStop['state']) => stop && Object.assign(stop, { state, lastHeartbeat: null });
    const step = (kind: TripStep['kind'], text: string, tone: TripStep['tone'], more: Partial<TripStep> = {}) =>
      void steps.push({ seq: e.seq, kind, stop: stop?.id ?? id, role: stop?.role ?? null, lane: stop?.lane ?? 'own', ...(stop?.peer && { peer: stop.peer }), cargo, text: line?.text ?? text, tone: line?.kind ?? tone, ...more });
    // An injected failure has an injection event before it, or it says "demo:" in its cause.
    const demo = (): Partial<TripStep> => ((id !== null && injected.delete(id)) || /demo: /i.test(e.cause) ? { injected: true } : {});

    if (e.action === 'plan' && !steps.length) step('start', `${e.cause[0]!.toUpperCase()}${e.cause.slice(1)}.`, 'ok');
    else if (e.action === 'peer_task') {
      cargo = carriesIn[stop?.role ?? ''] ?? cargo;
      step('start', `${e.cause}.`, 'ok');
    } else if (e.action === 'assign' && data.peer && stop) stop.peer = data.peer;
    else if (e.action === 'restart') step('restart', '', 'recovery');
    else if (e.action === 'injection') {
      if (id) injected.add(id);
      step('injection', '', 'trouble');
    } else if (e.action === 'dispatch' && e.result === 'started') {
      set('working');
      step('work', `${who} started the ${name} task.`, 'ok');
    } else if (e.action === 'heartbeat' && stop) stop.lastHeartbeat = e.time;
    else if (foundFailure(e)) {
      set('blocked');
      step('failure', '', 'trouble', { failure: e.result, sign: signs[e.result], ...demo() });
    } else if (e.action === 'retry') step('retry', '', 'recovery', { retry: data.retry, of: data.of, waitMs: data.waitMs });
    else if (e.action === 'reroute') {
      if (stop) Object.assign(stop, { lane: data.peer ? 'peer' : 'backup', peer: data.peer });
      step('reroute', '', 'recovery');
    } else if (e.action === 'review' && e.result === 'rejected') {
      // The script stop is rejected, and the review waits for the new script. A review that a peer asked for has no script stop: it stays done.
      if (stop && stop.role !== 'reviewer') {
        set('rejected');
        for (const s of stops.values()) if (s.role === 'reviewer') s.state = 'waiting';
      }
      cargo = 'Hints';
      step('rejection', '', 'trouble', { sign: signs.rejected, ...demo() });
    } else if (e.action === 'review') step('pass', 'The reviewer passed every script.', 'ok');
    else if (e.action === 'validate' && e.result === 'valid') {
      set('done');
      if (id) injected.delete(id);
      cargo = carriesOut[stop?.role ?? ''] ?? cargo;
      step('done', `${who} finished the ${name} task.`, 'ok');
    } else if (e.action === 'goal_to_peer') {
      cargo = 'Goal';
      step('goal_to_peer', '', 'recovery', { stop: 'goal', role: 'goal', lane: 'peer_goal', peer: e.result });
    } else if (e.action === 'escalate') set('blocked');
    else if (e.action === 'end') step('end', 'The run ended as done.', 'end');
  }
  return { status: run.status, forPeer: run.forPeer, stops: [...stops.values()], steps };
}
