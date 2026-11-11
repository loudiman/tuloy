import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import { runAgent } from './agent-runner.ts';
import type { Clock } from './clock.ts';
import { planTaskGraph } from './planner.ts';
import { nextAction, type Failure } from './recovery-policy.ts';
import { roles } from './schemas.ts';
import type { Limits } from './settings.ts';
import type { Store, TaskStatus } from './store.ts';

export type Conductor = ReturnType<typeof createConductor>;

/**
 * The conductor owns a run from the goal to its end. Read what it did from the store: the task rows and the event log.
 * Recovery: a failed or stalled task goes to the recovery policy; the conductor does the action that the policy returns.
 * ponytail: tasks run one at a time. The backup model is not used yet.
 */
export function createConductor({ store, models, clock, limits }: { store: Store; models: { primary: LanguageModel; backup: LanguageModel }; clock: Clock; limits: Limits }) {
  /** Stores the task graph and starts the run. `ended` resolves when the run is done or escalated; it never rejects. */
  function startRun(goal: string): { runId: number; ended: Promise<void> } {
    const tasks = planTaskGraph(goal);
    const runId = store.createRun(goal, tasks);
    store.append({ runId, action: 'plan', cause: 'the owner gave a goal', result: `task graph stored: ${tasks.length} tasks` });
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
    const input = roles[task.role].input.parse(Object.assign({ goal: run.goal }, ...deps.map((d) => d.output)));
    if (deps.length) {
      store.append({ runId, taskId, action: 'handoff', cause: `${deps.map((d) => d.id).join(', ')} done`, result: 'checked content stored', data: { from: deps.map((d) => d.id), content: input } });
    }
    // One turn of this loop is one attempt. The earlier failures of the task are the history for the recovery policy.
    const history: Failure[] = [];
    let output: unknown;
    for (;;) {
      store.append({ runId, taskId, action: 'dispatch', cause: history.length ? `retry ${history.length} of ${limits.retries}` : 'the tasks it depends on are done', result: 'started' });
      // Demo mode: a pending injection for this agent is used now, one time.
      const injected = store.takeInjection(task.role);
      if (injected) store.append({ runId, taskId, action: 'injection', cause: 'demo: the presenter injected this failure', result: injected });
      const result = await runAgent(task.role, input, models.primary, {
        clock,
        limits,
        injected,
        onHeartbeat: () => store.append({ runId, taskId, action: 'heartbeat', cause: 'the agent waits for the model', result: 'alive' }),
      });
      if (result.ok) {
        output = result.output;
        break;
      }
      const { failure } = result;
      store.append({ runId, taskId, action: failureAction[failure.kind], cause: failure.detail, result: failure.kind });
      store.updateTask(runId, taskId, { status: failedStatus[failure.kind] });

      const action = nextAction(failure, history, limits);
      if (action.do === 'escalate') {
        store.append({ runId, taskId, action: 'escalate', cause: action.cause, result: 'escalated' });
        store.updateTask(runId, taskId, { status: 'escalated' });
        endRun(runId, 'escalated', `${taskId} failed: ${failure.kind}`);
        return 'escalated';
      }
      store.append({ runId, taskId, action: 'retry', cause: failure.kind, result: 'waiting', data: action });
      await clock.sleep(action.waitMs);
      if (store.run(runId)?.status !== 'running') return 'escalated';
      history.push(failure);
      store.updateTask(runId, taskId, { status: 'recovering' });
    }
    store.append({ runId, taskId, action: 'validate', cause: `the output matches the ${task.role} schema`, result: 'valid' });
    store.updateTask(runId, taskId, { status: 'done', output });

    // A rejection is a failure of the script task. The scheduler starts only after a pass.
    if (task.role === 'reviewer') {
      const { reviews } = output as z.infer<typeof roles.reviewer.output>;
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

  return { startRun, startTask };
}

const isWaiting = (status: string) => status === 'queued' || status === 'waiting_on_dependency';

/** The stored status of a task after each failure. */
const failedStatus: Record<Failure['kind'], TaskStatus> = {
  timeout: 'stalled_timeout',
  missed_heartbeat: 'stalled_heartbeat',
  invalid_output: 'failed_validation',
  model_unavailable: 'model_unavailable',
  rate_limited: 'model_unavailable',
};

/** The event action that finds each failure. */
const failureAction: Record<Failure['kind'], string> = {
  timeout: 'watch',
  missed_heartbeat: 'watch',
  invalid_output: 'validate',
  model_unavailable: 'model_call',
  rate_limited: 'model_call',
};
