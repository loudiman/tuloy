import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import { runAgent } from './agent-runner.ts';
import { planTaskGraph } from './planner.ts';
import { roles, type Role } from './schemas.ts';
import type { Store } from './store.ts';

export type Conductor = ReturnType<typeof createConductor>;

/**
 * The conductor owns a run from the goal to its end. Read what it did from the store: the task rows and the event log.
 * ponytail: no recovery, a failure ends the run as escalated; tasks run one at a time. The backup model is not used yet.
 */
export function createConductor({ store, models }: { store: Store; models: { primary: LanguageModel; backup: LanguageModel } }) {
  /** Stores the task graph and starts the run. `ended` resolves when the run is done or escalated; it never rejects. */
  function startRun(goal: string): { runId: number; ended: Promise<void> } {
    const tasks = planTaskGraph(goal);
    const runId = store.createRun(goal, tasks);
    store.append({ runId, action: 'plan', cause: 'the owner gave a goal', result: `task graph stored: ${tasks.length} tasks` });
    return { runId, ended: drive(runId) };
  }

  /**
   * Starts a run of one task for a peer: that agent runs once, on the input that the peer gave.
   * The caller checks the input against the role's input schema first. Read the result from the task row when `ended` resolves.
   */
  function startPeerTask(peer: string, role: Role, input: { goal: string }): { runId: number; ended: Promise<void> } {
    const task = { ...planTaskGraph(input.goal).find((t) => t.role === role)!, dependsOn: [], input };
    const runId = store.createRun(input.goal, [task], peer);
    store.append({ runId, taskId: task.id, action: 'peer_task', cause: `${peer} sent a task for the ${role} agent`, result: `accepted for ${peer}`, data: { peer, input } });
    return { runId, ended: drive(runId) };
  }

  async function drive(runId: number): Promise<void> {
    try {
      while (store.run(runId)?.status === 'running') {
        const tasks = store.tasks(runId);
        const next = tasks.find((t) => isWaiting(t.status) && t.dependsOn.every((d) => tasks.find((x) => x.id === d)?.status === 'done'));
        if (!next) return endRun(runId, 'done', 'all tasks are done');
        await startTask(runId, next.id);
      }
    } catch (error) {
      endRun(runId, 'escalated', `the conductor hit an error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function endRun(runId: number, status: 'done' | 'escalated', cause: string) {
    store.endRun(runId, status);
    store.append({ runId, action: 'end', cause, result: status });
  }

  /**
   * Starts one task now and resolves when the task has ended. The conductor uses this for every start.
   * A start is rejected, with an event, when a task it depends on is not done, when the task is not waiting, or when the run has ended.
   */
  async function startTask(runId: number, taskId: string): Promise<'done' | 'rejected' | 'escalated'> {
    const run = store.run(runId);
    const tasks = store.tasks(runId);
    const task = tasks.find((t) => t.id === taskId);
    if (!run || !task) throw new Error(`no task ${taskId} in run ${runId}`);
    const deps = task.dependsOn.map((id) => tasks.find((t) => t.id === id)!);
    const notDone = deps.filter((d) => d.status !== 'done').map((d) => d.id);
    const why = notDone.length ? `it depends on ${notDone.join(', ')}, not done yet` : !isWaiting(task.status) ? `the task is ${task.status}` : run.status !== 'running' ? `the run is ${run.status}` : null;
    if (why) {
      store.append({ runId, taskId, action: 'dispatch', cause: why, result: 'rejected' });
      return 'rejected';
    }

    const agent = task.role;
    store.updateTask(runId, taskId, { agent, status: 'running' });
    store.append({ runId, taskId, action: 'assign', cause: 'the task is ready', result: agent, data: { model: 'primary' } });

    // The next agent gets only the checked fields of its role's input schema.
    const input = roles[task.role].input.parse(Object.assign({ goal: run.goal }, task.input, ...deps.map((d) => d.output)));
    if (deps.length) {
      store.append({ runId, taskId, action: 'handoff', cause: `${deps.map((d) => d.id).join(', ')} done`, result: 'checked content stored', data: { from: deps.map((d) => d.id), content: input } });
    }
    store.append({ runId, taskId, action: 'dispatch', cause: 'the tasks it depends on are done', result: 'started' });

    const result = await runAgent(task.role, input, models.primary);
    if (!result.ok) {
      store.append({ runId, taskId, action: result.failure === 'invalid_output' ? 'validate' : 'model_call', cause: result.detail, result: result.failure });
      store.updateTask(runId, taskId, { status: 'escalated' });
      endRun(runId, 'escalated', `${taskId} failed: ${result.failure}`);
      return 'escalated';
    }
    store.append({ runId, taskId, action: 'validate', cause: `the output matches the ${task.role} schema`, result: 'valid' });
    store.updateTask(runId, taskId, { status: 'done', output: result.output });

    // A rejection is a failure of the script task. The scheduler starts only after a pass.
    if (task.role === 'reviewer') {
      const { reviews } = result.output as z.infer<typeof roles.reviewer.output>;
      const rejected = reviews.filter((r) => r.verdict === 'reject');
      const scriptTaskId = deps.find((d) => d.role === 'script')?.id ?? taskId;
      if (rejected.length) {
        store.append({ runId, taskId: scriptTaskId, action: 'review', cause: rejected.map((r) => `${r.script_id}: ${r.issues.join(' ')}`).join('; '), result: 'rejected', data: { reviews } });
        store.updateTask(runId, scriptTaskId, { status: 'rejected' });
        endRun(runId, 'escalated', `the reviewer rejected ${scriptTaskId}`);
        return 'escalated';
      }
      store.append({ runId, taskId: scriptTaskId, action: 'review', cause: 'the reviewer passed every script', result: 'pass' });
    }
    return 'done';
  }

  return { startRun, startPeerTask, startTask };
}

const isWaiting = (status: string) => status === 'queued' || status === 'waiting_on_dependency';
