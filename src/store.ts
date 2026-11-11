import { DatabaseSync } from 'node:sqlite';
import type { PlannedTask } from './planner.ts';
import type { Role } from './schemas.ts';

export type Clock = { now(): number };

export type RunStatus = 'running' | 'done' | 'escalated';
export type TaskStatus =
  | 'queued'
  | 'waiting_on_dependency'
  | 'running'
  | 'stalled_timeout'
  | 'stalled_heartbeat'
  | 'failed_validation'
  | 'rejected'
  | 'model_unavailable'
  | 'recovering'
  | 'done'
  | 'escalated';

export type Run = { id: number; goal: string; status: RunStatus; startedAt: number; endedAt: number | null };
export type Task = {
  id: string;
  title: string;
  dependsOn: string[];
  role: Role;
  status: TaskStatus;
  /** The one agent that has the task now. Null until the first assignment. */
  agent: string | null;
  /** The checked output. Null until the task is done. */
  output: unknown;
};
/** One line of the event log. `data` holds the content of the event, for example a handoff's checked fields. */
export type TuloyEvent = {
  seq: number;
  time: number;
  runId: number;
  taskId: string | null;
  cause: string;
  action: string;
  result: string;
  data: unknown;
};
export type NewEvent = Pick<TuloyEvent, 'runId' | 'action' | 'result' | 'cause'> & { taskId?: string; data?: unknown };

export type Store = ReturnType<typeof openStore>;

type Row = Record<string, any>;

/** One SQLite file per Tuloy (or ':memory:'). The event log is append-only: there is no update or delete for events. */
export function openStore(file: string, clock: Clock) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, goal TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE IF NOT EXISTS tasks (run_id INTEGER NOT NULL, position INTEGER NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, depends_on TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, agent TEXT, output TEXT, PRIMARY KEY (run_id, id));
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, run_id INTEGER NOT NULL, task_id TEXT,
      cause TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, data TEXT);
  `);
  const listeners = new Set<(event: TuloyEvent) => void>();

  const toRun = (r: Row): Run => ({ id: r.id, goal: r.goal, status: r.status, startedAt: r.started_at, endedAt: r.ended_at });
  const toTask = (r: Row): Task => ({
    id: r.id,
    title: r.title,
    dependsOn: JSON.parse(r.depends_on),
    role: r.role,
    status: r.status,
    agent: r.agent,
    output: r.output === null ? null : JSON.parse(r.output),
  });
  const toEvent = (r: Row): TuloyEvent => ({
    seq: r.seq,
    time: r.time,
    runId: r.run_id,
    taskId: r.task_id,
    cause: r.cause,
    action: r.action,
    result: r.result,
    data: r.data === null ? null : JSON.parse(r.data),
  });

  return {
    /** Stores a run and its task graph. A task with no dependency is queued; the others wait. */
    createRun(goal: string, tasks: PlannedTask[]): number {
      const runId = Number(db.prepare('INSERT INTO runs (goal, status, started_at) VALUES (?, ?, ?)').run(goal, 'running', clock.now()).lastInsertRowid);
      const insert = db.prepare('INSERT INTO tasks (run_id, position, id, title, depends_on, role, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
      tasks.forEach((t, i) => insert.run(runId, i, t.id, t.title, JSON.stringify(t.dependsOn), t.role, t.dependsOn.length ? 'waiting_on_dependency' : 'queued'));
      return runId;
    },
    run(runId: number): Run | undefined {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
      return row && toRun(row);
    },
    /** All runs, newest first. */
    runs(): Run[] {
      return db.prepare('SELECT * FROM runs ORDER BY id DESC').all().map(toRun);
    },
    tasks(runId: number): Task[] {
      return db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY position').all(runId).map(toTask);
    },
    events(runId: number): TuloyEvent[] {
      return db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq').all(runId).map(toEvent);
    },
    updateTask(runId: number, taskId: string, patch: { status?: TaskStatus; agent?: string; output?: unknown }) {
      if (patch.status) db.prepare('UPDATE tasks SET status = ? WHERE run_id = ? AND id = ?').run(patch.status, runId, taskId);
      if (patch.agent) db.prepare('UPDATE tasks SET agent = ? WHERE run_id = ? AND id = ?').run(patch.agent, runId, taskId);
      if (patch.output !== undefined) db.prepare('UPDATE tasks SET output = ? WHERE run_id = ? AND id = ?').run(JSON.stringify(patch.output), runId, taskId);
    },
    endRun(runId: number, status: 'done' | 'escalated') {
      db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE id = ?').run(status, clock.now(), runId);
    },
    append(event: NewEvent): TuloyEvent {
      const time = clock.now();
      const { taskId = null, data = null } = event;
      const seq = Number(
        db
          .prepare('INSERT INTO events (time, run_id, task_id, cause, action, result, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(time, event.runId, taskId, event.cause, event.action, event.result, data === null ? null : JSON.stringify(data)).lastInsertRowid,
      );
      const stored: TuloyEvent = { seq, time, runId: event.runId, taskId, cause: event.cause, action: event.action, result: event.result, data };
      for (const listener of listeners) listener(stored);
      return stored;
    },
    /** Calls `listener` for each new event. Returns the function that stops it. */
    subscribe(listener: (event: TuloyEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      db.close();
    },
  };
}
