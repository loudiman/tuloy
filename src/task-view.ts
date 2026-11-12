import type { Skill } from './schemas.ts';
import type { Task, TaskStatus, TuloyEvent } from './store.ts';

/** The status words that the owner reads. */
export type ShownStatus = 'queued' | 'waiting on dependency' | 'running' | 'stalled' | 'recovering' | 'done' | 'escalated';

const shown: Record<TaskStatus, ShownStatus> = {
  queued: 'queued',
  waiting_on_dependency: 'waiting on dependency',
  running: 'running',
  stalled_timeout: 'stalled',
  stalled_heartbeat: 'stalled',
  failed_validation: 'stalled',
  rejected: 'stalled',
  model_unavailable: 'stalled',
  recovering: 'recovering',
  done: 'done',
  escalated: 'escalated',
};

const agentName: Record<Skill, string> = { trend_scout: 'Trend scout', script: 'Script', reviewer: 'Reviewer', scheduler: 'Scheduler', goal: 'Full goal' };

/** What went wrong, from the event that found the failure. The key is the event's result. */
const whatFailed: Record<string, (event: TuloyEvent) => string> = {
  timeout: (e) => `stalled: ${e.cause}`,
  missed_heartbeat: (e) => `stalled: ${e.cause}`,
  invalid_output: () => 'failed: its output did not match the schema',
  rate_limited: () => 'failed: the model is rate-limited',
  peer_failed: (e) => `failed: ${e.cause}`,
  // The main issue is the first issue of the first rejected script.
  rejected: (e) => `rejected by the reviewer: ${((e.data as { reviews: { verdict: string; issues: string[] }[] }).reviews.find((r) => r.verdict === 'reject')?.issues[0] ?? 'no issue given').replace(/\.$/, '')}`,
  model_unavailable: (e) => `failed: the model is not available (${e.cause.replace(/\.$/, '').slice(0, 300)})`,
};

/** Each task with its shown status and, when it is stalled, recovering or escalated, its stuck reason. */
export function taskViews(tasks: Task[], events: TuloyEvent[]): (Task & { shownStatus: ShownStatus; stuckReason: string | null })[] {
  return tasks.map((task) => ({ ...task, shownStatus: shown[task.status], stuckReason: stuckReason(task, events) }));
}

/**
 * The stuck reason: one short sentence that says why the task is not moving and what the conductor did about it.
 * It is made from the task's events only: the last failure, and the recovery action after it.
 */
function stuckReason(task: Task, events: TuloyEvent[]): string | null {
  if (!['stalled', 'recovering', 'escalated'].includes(shown[task.status])) return null;
  const mine = events.filter((e) => e.taskId === task.id);
  const failure = mine.findLast((e) => ['watch', 'validate', 'model_call', 'review', 'peer_call'].includes(e.action) && e.result in whatFailed);
  if (!failure) return null;
  const recovery = mine.findLast((e) => e.seq > failure.seq && ['retry', 'reroute', 'escalate'].includes(e.action));
  const retry = recovery?.data as { retry: number; of: number; waitMs: number } | null;
  const did = !recovery
    ? ''
    : recovery.action === 'escalate'
      ? ` ${recovery.cause[0].toUpperCase()}${recovery.cause.slice(1)}. The run ended as escalated.`
      : recovery.action === 'reroute'
        ? ` Re-routed to ${recovery.result} after ${recovery.cause}.`
        : ` Retry ${retry!.retry} of ${retry!.of} ${task.status === 'recovering' ? 'is running' : `in ${retry!.waitMs / 1000}s`}.`;
  return `${agentName[task.role]} task ${whatFailed[failure.result](failure)}.${did}`;
}

export type RecoveryLine = { kind: 'trouble' | 'recovery' | 'ok' | 'end'; text: string };

/** True for the event that finds a failure of an agent. A reviewer rejection is not one of these: it has its own event. */
export const foundFailure = (e: TuloyEvent) => ['watch', 'validate', 'model_call', 'peer_call'].includes(e.action) && e.result in whatFailed;

/**
 * The recovery summary of a run: what went wrong and what the conductor did about it, as plain sentences in the order of the events.
 * It is made from the events only. A run with no failure has no line.
 */
export const recoverySummary = (events: TuloyEvent[]): RecoveryLine[] => replay(events).flatMap(({ line }) => (line ? [line] : []));

/**
 * Each event with what is known at that event: the name of the task's role, who has the task, and the line of the recovery summary, if the event has one.
 * A line is made from the events up to its own event only, so more events never change an earlier line.
 */
export function replay(events: TuloyEvent[]): { event: TuloyEvent; name: string; who: string; line?: RecoveryLine }[] {
  let lines = 0;
  // For each task: the name of its role, who has it now, and if a failure waits for a good output.
  const role = new Map<string, string>();
  const holder = new Map<string, string>();
  const open = new Set<string>();
  let rejected = false;
  let stopped = '';
  return events.map((e) => {
    let line: RecoveryLine | undefined;
    const say = (kind: RecoveryLine['kind'], text: string) => void ((line = { kind, text }), lines++);
    const id = e.taskId ?? '';
    const data = (e.data ?? {}) as { peer?: string; retry?: number; of?: number; reviews?: { script_id: string; verdict: string }[] };
    if (e.action === 'assign') {
      if (data.peer) holder.set(id, e.result);
      else role.set(id, e.result.replaceAll('_', ' '));
    }
    const name = role.get(id) ?? id;
    const who = holder.get(id) ?? `The ${name} agent`;
    if (e.action === 'restart') say('recovery', 'Tuloy started again, and the conductor continued the run.');
    else if (e.action === 'injection') say('trouble', `Demo: the presenter injected a failure of the ${name} agent (${e.result.replaceAll('_', ' ')}).`);
    else if (e.action === 'review' && e.result === 'rejected') {
      rejected = true;
      open.add(id);
      say('trouble', `The reviewer rejected ${data.reviews?.filter((r) => r.verdict === 'reject').map((r) => r.script_id).join(', ') || 'a script'}.`);
    } else if (e.action === 'review' && e.result === 'pass') {
      if (rejected) say('ok', 'The reviewer passed every script.');
    } else if (foundFailure(e)) {
      open.add(id);
      say('trouble', who === 'The backup model' ? 'The backup model failed also.' : `${who} ${whatFailed[e.result](e)}.`);
    } else if (e.action === 'retry') say('recovery', `The conductor started the ${name} agent again (retry ${data.retry} of ${data.of}).`);
    else if (e.action === 'reroute') {
      holder.set(id, data.peer ? e.result : 'The backup model');
      say('recovery', `The conductor re-routed the ${name} task to ${data.peer ? e.result : 'the backup model'}.`);
    } else if (e.action === 'goal_to_peer') {
      open.add('goal'); // the one task of the new task graph version
      say('recovery', `The conductor gave the full goal to ${e.result}.`);
    } else if (e.action === 'validate' && e.result === 'valid' && open.delete(id)) say('ok', `${who} finished the ${name} task.`);
    else if (e.action === 'escalate') stopped = `: ${e.cause}`;
    else if (e.action === 'end' && e.result === 'escalated') say('end', `The run ended as escalated${stopped}.`);
    else if (e.action === 'end' && lines) say('end', 'The run ended as done.');
    return { event: e, name, who: holder.get(id) ?? who, line };
  });
}
