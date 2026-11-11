import { DatabaseSync } from 'node:sqlite';
import type { PlannedTask } from './planner.ts';
import type { Skill } from './schemas.ts';

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

export type Run = {
  id: number;
  goal: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  /** The name of the peer that this run works for. Null for the owner's own runs. */
  forPeer: string | null;
};
/** One entry of the allowed list. `sendKey` goes out with work for the peer; `acceptKey` is the key this Tuloy accepts from the peer. */
export type Peer = { name: string; address: string; sendKey: string; acceptKey: string };
export type Task = {
  id: string;
  title: string;
  dependsOn: string[];
  /** An agent role, or `goal` for the one task of a full goal that a peer does. */
  role: Skill;
  status: TaskStatus;
  /** The one agent that has the task now. Null until the first assignment. */
  agent: string | null;
  /** The checked output. Null until the task is done. */
  output: unknown;
  /** The input that a peer gave for this task. Null for a task that gets its input from a handoff. */
  input: unknown;
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

/** A pending injected failure. `task` is the agent role that gets it. */
export type Injection = { id: number; task: Skill; kind: string };

export type Store = ReturnType<typeof openStore>;

type Row = Record<string, any>;

/** One SQLite file per Tuloy (or ':memory:'). The event log is append-only: there is no update or delete for events. */
export function openStore(file: string, clock: { now(): number }) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, goal TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER);
    CREATE TABLE IF NOT EXISTS tasks (run_id INTEGER NOT NULL, position INTEGER NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, depends_on TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, agent TEXT, output TEXT, PRIMARY KEY (run_id, id));
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, run_id INTEGER NOT NULL, task_id TEXT,
      cause TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, data TEXT);
    CREATE TABLE IF NOT EXISTS injections (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peers (name TEXT PRIMARY KEY, address TEXT NOT NULL, send_key TEXT NOT NULL, accept_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
  `);
  // A data file from before the peer server has no such columns.
  for (const column of ['runs ADD COLUMN for_peer TEXT', 'tasks ADD COLUMN input TEXT', 'tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1']) {
    try {
      db.exec(`ALTER TABLE ${column}`);
    } catch {}
  }
  const listeners = new Set<(event: TuloyEvent) => void>();

  const toRun = (r: Row): Run => ({ id: r.id, goal: r.goal, status: r.status, startedAt: r.started_at, endedAt: r.ended_at, forPeer: r.for_peer });
  const toTask = (r: Row): Task => ({
    id: r.id,
    title: r.title,
    dependsOn: JSON.parse(r.depends_on),
    role: r.role,
    status: r.status,
    agent: r.agent,
    output: r.output === null ? null : JSON.parse(r.output),
    input: r.input === null ? null : JSON.parse(r.input),
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
    createRun(goal: string, tasks: PlannedTask[], forPeer: string | null = null): number {
      const runId = Number(db.prepare('INSERT INTO runs (goal, status, started_at, for_peer) VALUES (?, ?, ?, ?)').run(goal, 'running', clock.now(), forPeer).lastInsertRowid);
      const insert = db.prepare('INSERT INTO tasks (run_id, position, id, title, depends_on, role, status, input) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      tasks.forEach((t, i) =>
        insert.run(runId, i, t.id, t.title, JSON.stringify(t.dependsOn), t.role, t.dependsOn.length ? 'waiting_on_dependency' : 'queued', t.input === undefined ? null : JSON.stringify(t.input)),
      );
      return runId;
    },
    /**
     * Stores a new version of the task graph of a run and returns its number. The tasks of the earlier versions stay in the file,
     * and their events stay in the event log, but `tasks` gives only the newest version.
     */
    newTaskGraph(runId: number, tasks: PlannedTask[]): number {
      const version = Number(db.prepare('SELECT MAX(version) AS v FROM tasks WHERE run_id = ?').get(runId)!.v) + 1;
      const insert = db.prepare('INSERT INTO tasks (run_id, position, id, title, depends_on, role, status, input, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      tasks.forEach((t, i) =>
        insert.run(runId, i, t.id, t.title, JSON.stringify(t.dependsOn), t.role, t.dependsOn.length ? 'waiting_on_dependency' : 'queued', t.input === undefined ? null : JSON.stringify(t.input), version),
      );
      return version;
    },
    run(runId: number): Run | undefined {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
      return row && toRun(row);
    },
    /** All runs, newest first. */
    runs(): Run[] {
      return db.prepare('SELECT * FROM runs ORDER BY id DESC').all().map(toRun);
    },
    /** The tasks of the newest version of the run's task graph, or of the version given. */
    tasks(runId: number, version: number | null = null): Task[] {
      return db.prepare('SELECT * FROM tasks WHERE run_id = ?1 AND version = COALESCE(?2, (SELECT MAX(version) FROM tasks WHERE run_id = ?1)) ORDER BY position').all(runId, version).map(toTask);
    },
    events(runId: number): TuloyEvent[] {
      return db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY seq').all(runId).map(toEvent);
    },
    updateTask(runId: number, taskId: string, patch: { status?: TaskStatus; agent?: string; output?: unknown; input?: unknown }) {
      if (patch.input !== undefined) db.prepare('UPDATE tasks SET input = ? WHERE run_id = ? AND id = ?').run(JSON.stringify(patch.input), runId, taskId);
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
    /** Demo mode: adds a pending injection, a failure made on purpose for the next attempt of the agent with this role. */
    addInjection(task: Skill, kind: string): Injection {
      return { id: Number(db.prepare('INSERT INTO injections (task, kind) VALUES (?, ?)').run(task, kind).lastInsertRowid), task, kind };
    },
    /** The pending injections, oldest first. */
    injections(): Injection[] {
      return db.prepare('SELECT * FROM injections ORDER BY id').all().map((r: Row) => ({ id: r.id, task: r.task, kind: r.kind }));
    },
    /**
     * Removes and returns the oldest pending injection for this role. Each injection is used one time.
     * The kinds `peer_…` are for the attempt at a peer (`forPeerStep`); all other kinds are for an attempt on an own model.
     */
    takeInjection(task: Skill, forPeerStep = false): string | undefined {
      const row = db.prepare(`DELETE FROM injections WHERE id = (SELECT MIN(id) FROM injections WHERE task = ? AND kind ${forPeerStep ? '' : 'NOT'} LIKE 'peer%') RETURNING kind`).get(task);
      return row?.kind as string | undefined;
    },
    /** Removes every pending injection. */
    clearInjections() {
      db.exec('DELETE FROM injections');
    },
    /** Calls `listener` for each new event. Returns the function that stops it. */
    subscribe(listener: (event: TuloyEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Puts a peer on the allowed list. A peer with the same name is replaced. */
    addPeer(peer: Peer) {
      db.prepare('INSERT OR REPLACE INTO peers (name, address, send_key, accept_key) VALUES (?, ?, ?, ?)').run(peer.name, peer.address, peer.sendKey, peer.acceptKey);
    },
    /** Takes a peer off the allowed list. False when there was no such peer. */
    removePeer(name: string): boolean {
      return db.prepare('DELETE FROM peers WHERE name = ?').run(name).changes === 1;
    },
    /** The allowed list. */
    peers(): Peer[] {
      return db.prepare('SELECT * FROM peers ORDER BY name').all().map((r: Row) => ({ name: r.name, address: r.address, sendKey: r.send_key, acceptKey: r.accept_key }));
    },
    /** How many runs this Tuloy started for the peer in the last hour. */
    peerRunsInLastHour(name: string): number {
      return Number(db.prepare('SELECT COUNT(*) AS n FROM runs WHERE for_peer = ? AND started_at > ?').get(name, clock.now() - 60 * 60 * 1000)!.n);
    },
    /** Saves an open invite. Only the hash of its token is stored. It stops working after 24 hours. */
    createInvite(tokenHash: string) {
      db.prepare('INSERT INTO invites (token_hash, expires_at) VALUES (?, ?)').run(tokenHash, clock.now() + 24 * 60 * 60 * 1000);
    },
    /** True when there is such an invite, it is not used and it is not older than 24 hours. */
    inviteIsOpen(tokenHash: string): boolean {
      return !!db.prepare('SELECT 1 FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(tokenHash, clock.now());
    },
    /** Uses up an open invite. False when it was not open: an invite works one time. */
    useInvite(tokenHash: string): boolean {
      return db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').run(clock.now(), tokenHash, clock.now()).changes === 1;
    },
    /** Does the writes of `work` as one transaction: all of them are in the file, or none. `work` must not wait for anything. */
    transaction<T>(work: () => T): T {
      db.exec('BEGIN');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {} // the file is closed: SQLite dropped the open transaction already
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
