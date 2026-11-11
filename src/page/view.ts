/**
 * The pure part of the dashboard: what the page shows, worked out from the run, the task rows and the event log.
 * The server sends this file to the browser with its types removed, and the tests import it directly.
 * Every field that a later ticket adds (shownStatus, stuckReason, forPeer) is optional here: a missing field shows nothing.
 */

export type ShownStatus = 'queued' | 'waiting on dependency' | 'running' | 'stalled' | 'recovering' | 'done' | 'escalated';

const shownWords: Record<string, ShownStatus> = {
  queued: 'queued',
  waiting_on_dependency: 'waiting on dependency',
  running: 'running',
  stalled_timeout: 'stalled',
  stalled_heartbeat: 'stalled',
  failed_validation: 'recovering',
  rejected: 'recovering',
  model_unavailable: 'recovering',
  recovering: 'recovering',
  done: 'done',
  escalated: 'escalated',
};

/** The plain status word of a task. The server's word wins; without it, the page works the word out from the stored status. */
export function shownStatus(task: { status: string; shownStatus?: string | null }, runStatus: string): string {
  const word = task.shownStatus || (shownWords[task.status] ?? task.status.replaceAll('_', ' '));
  // A run that ended as escalated has no recovery left: the task that was stuck is where the run stopped.
  return runStatus === 'escalated' && (word === 'stalled' || word === 'recovering' || word === 'running') ? 'escalated' : word;
}

export type RunView = { id: number; goal: string; status: string; startedAt: number; endedAt: number | null; forPeer?: string | null };
export type TaskView = {
  id: string;
  title: string;
  role: string;
  agent: string | null;
  dependsOn: string[];
  status: string;
  output: unknown;
  shownStatus?: string | null;
  stuckReason?: string | null;
};

const manilaFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Manila',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** A time in Manila time (PHT, UTC+8), for example "12 Nov 2026, 09:00:00". */
export function manilaTime(ms: number): string {
  return manilaFormat.format(ms);
}

/** A length of time as hours, minutes and seconds: "00:01:15". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

/** The facts of the header. Only real counts from the run. */
export function headerOf(run: RunView, tasks: TaskView[], now: number) {
  const stuckWords = ['stalled', 'recovering', 'escalated'];
  return {
    started: manilaTime(run.startedAt),
    passed: duration((run.endedAt ?? now) - run.startedAt),
    done: tasks.filter((t) => shownStatus(t, run.status) === 'done').length,
    total: tasks.length,
    stuck: tasks.find((t) => stuckWords.includes(shownStatus(t, run.status))) ?? null,
  };
}

export type EventView = { seq: number; time: number; runId: number; taskId: string | null; cause: string; action: string; result: string; data: unknown };

const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const words = (text: string) => text.replaceAll('_', ' ');

/** Titles for the event actions of today. An action that is not here still gets a row: its own name is the title. */
const titles: Record<string, string> = {
  plan: 'Task graph made',
  assign: 'Agent assigned',
  handoff: 'Handoff',
  dispatch: 'Start',
  validate: 'Output check',
  model_call: 'Model call',
  review: 'Review',
  end: 'Run ended',
};

const recovery = /retry|re-?route|switch|backup|peer|recover/i;
const trouble = /reject|invalid|unavailable|escalat|fail|timeout|timed|stall|refus|outage|error|missed|silent|limit/i;

/** One row of the timeline. `kind` picks the mark of the row: a handoff, a recovery action, trouble, or a plain row. */
export function timelineOf(events: EventView[], taskId: string | null) {
  return events
    .filter((e) => taskId === null || e.taskId === taskId)
    .map((e) => ({
      seq: e.seq,
      taskId: e.taskId,
      time: clockFormat.format(e.time),
      title: titles[e.action] ?? words(e.action).replace(/^./, (c) => c.toUpperCase()),
      result: words(e.result),
      cause: e.cause,
      kind: e.action === 'handoff' ? 'handoff' : recovery.test(e.action) ? 'recovery' : trouble.test(e.result) ? 'trouble' : 'plain',
      data: e.data,
    }));
}
