import type { Role } from './schemas.ts';

/** `input` is set only on a task that a peer sent: the peer gives the input, no handoff does. */
export type PlannedTask = { id: string; title: string; dependsOn: string[]; role: Role; input?: unknown };

/** The labelled sample goal. The page starts it in one action. */
export const SAMPLE_GOAL = 'Make short-video scripts and a posting schedule for a sari-sari store in Quezon City this week.';

/**
 * Goal → task graph. First version: the fixed traffic-studio template for every goal.
 * The scheduler depends on the scripts and on their review, so it gets both as checked input.
 */
export function planTaskGraph(_goal: string): PlannedTask[] {
  return checkTaskGraph([
    { id: 'trends', title: 'Find trends', dependsOn: [], role: 'trend_scout' },
    { id: 'scripts', title: 'Write scripts', dependsOn: ['trends'], role: 'script' },
    { id: 'review', title: 'Review scripts', dependsOn: ['scripts'], role: 'reviewer' },
    { id: 'schedule', title: 'Make the posting schedule', dependsOn: ['scripts', 'review'], role: 'scheduler' },
  ]);
}

/** Throws unless the graph has at least one root, no unknown dependency and no cycle. */
export function checkTaskGraph(tasks: PlannedTask[]): PlannedTask[] {
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) for (const d of t.dependsOn) if (!ids.has(d)) throw new Error(`task ${t.id} depends on unknown task ${d}`);
  if (!tasks.some((t) => t.dependsOn.length === 0)) throw new Error('the task graph has no root');
  const done = new Set<string>();
  while (done.size < tasks.length) {
    const ready = tasks.filter((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) throw new Error('the task graph has a cycle');
    for (const t of ready) done.add(t.id);
  }
  return tasks;
}
