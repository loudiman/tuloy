import type { Role } from './schemas.ts';
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

const agentName: Record<Role, string> = { trend_scout: 'Trend scout', script: 'Script', reviewer: 'Reviewer', scheduler: 'Scheduler' };

/** What went wrong, from the event that found the failure. The key is the event's result. */
const whatFailed: Record<string, (event: TuloyEvent) => string> = {
  timeout: (e) => `stalled: ${e.cause}`,
  missed_heartbeat: (e) => `stalled: ${e.cause}`,
  invalid_output: () => 'failed: its output did not match the schema',
  rate_limited: () => 'failed: the model is rate-limited',
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
  const failure = mine.findLast((e) => ['watch', 'validate', 'model_call'].includes(e.action) && e.result in whatFailed);
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
