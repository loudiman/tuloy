import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import { runAgent, type AgentResult } from './agent-runner.ts';
import type { Clock } from './clock.ts';
import { planTaskGraph } from './planner.ts';
import { nextAction, type Failure } from './recovery-policy.ts';
import { roles, type Role } from './schemas.ts';
import type { Limits } from './settings.ts';
import type { Store, TaskStatus } from './store.ts';

export type Conductor = ReturnType<typeof createConductor>;

/**
 * The conductor owns a run from the goal to its end. Read what it did from the store: the task rows and the event log.
 * Recovery: a failed or stalled task goes to the recovery policy; the conductor does the action that the policy returns.
 * ponytail: in one run, tasks start one at a time (the template graph never has two ready tasks). Runs go side by side. The backup model is not used yet.
 */
export function createConductor({ store, models, clock, limits }: { store: Store; models: { primary: LanguageModel; backup: LanguageModel }; clock: Clock; limits: Limits }) {
  // At most `limits.maxModelCalls` agents run at the same time, over all runs of this Tuloy. The others wait in line.
  let freeSlots = limits.maxModelCalls;
  const line: (() => void)[] = [];
  async function withModelSlot<T>(work: () => Promise<T>): Promise<T> {
    if (freeSlots > 0) freeSlots--;
    else await new Promise<void>((resolve) => line.push(resolve));
    try {
      return await work();
    } finally {
      const next = line.shift();
      if (next) next(); // the slot goes directly to the next in line
      else freeSlots++;
    }
  }

  /** For each running run: the earlier failures of each task, and a reviewer rejection that waits for the recovery of the script task. */
  const memory = new Map<number, { history: Record<string, Failure[]>; rejection?: { taskId: string; failure: Failure } }>();
  const remember = (runId: number) => memory.get(runId) ?? memory.set(runId, { history: {} }).get(runId)!;

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
        const next = tasks.find((t) => (isWaiting(t.status) || t.status === 'rejected') && t.dependsOn.every((d) => tasks.find((x) => x.id === d)?.status === 'done'));
        if (!next) return endRun(runId, 'done', 'all tasks are done');
        await startTask(runId, next.id);
      }
    } catch (error) {
      endRun(runId, 'escalated', `the conductor hit an error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function endRun(runId: number, status: 'done' | 'escalated', cause: string) {
    store.endRun(runId, status);
    memory.delete(runId);
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
    // A script that the reviewer rejected starts again here: the rejection is its failure, and the loop below recovers from it.
    const mind = remember(runId);
    let rejection = mind.rejection?.taskId === taskId ? mind.rejection.failure : undefined;
    const why = notDone.length ? `it depends on ${notDone.join(', ')}, not done yet` : !isWaiting(task.status) && !rejection ? `the task is ${task.status}` : run.status !== 'running' ? `the run is ${run.status}` : null;
    if (why) {
      store.append({ runId, taskId, action: 'dispatch', cause: why, result: 'rejected' });
      return 'rejected';
    }

    const agent = task.role;
    if (rejection) mind.rejection = undefined;
    else {
      store.updateTask(runId, taskId, { agent, status: 'running' });
      store.append({ runId, taskId, action: 'assign', cause: 'the task is ready', result: agent, data: { model: 'primary' } });
    }

    // The next agent gets only the checked fields of its role's input schema.
    const input = roles[task.role].input.parse(Object.assign({ goal: run.goal }, task.input, ...deps.map((d) => d.output)));
    const handoff = (cause: string) => deps.length && store.append({ runId, taskId, action: 'handoff', cause, result: 'checked content stored', data: { from: deps.map((d) => d.id), content: input } });
    if (!rejection) handoff(`${deps.map((d) => d.id).join(', ')} done`);
    // One turn of this loop is one attempt. The earlier failures of the task are the history for the recovery policy.
    const history = (mind.history[taskId] ??= []);
    let output: unknown;
    for (;;) {
      if (!rejection) store.append({ runId, taskId, action: 'dispatch', cause: history.length ? `retry ${history.length} of ${limits.retries}` : 'the tasks it depends on are done', result: 'started' });
      // Demo mode: a pending injection for this agent is used now, one time.
      const injected = rejection ? undefined : store.takeInjection(task.role);
      if (injected) store.append({ runId, taskId, action: 'injection', cause: 'demo: the presenter injected this failure', result: injected });
      // An injected rejection of the script acts in the review of that script: the script agent hands it to the reviewer.
      if (injected === 'reviewer_rejection' && task.role === 'script') store.addInjection('reviewer', injected);
      // The time limit starts when the agent has its slot, not while it waits in line.
      const result: AgentResult = rejection ? { ok: false, failure: rejection } : await withModelSlot(() =>
        runAgent(task.role, input, models.primary, {
          clock,
          limits,
          injected,
          onHeartbeat: () => store.append({ runId, taskId, action: 'heartbeat', cause: 'the agent waits for the model', result: 'alive' }),
        }),
      );
      if (result.ok) {
        output = result.output;
        break;
      }
      const { failure } = result;
      // The `review` event of a rejection is in the log already.
      if (!rejection) store.append({ runId, taskId, action: failureAction[failure.kind], cause: failure.detail, result: failure.kind });
      rejection = undefined;
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
      // The input of this retry is new: it has the reviewer's issues and hints.
      if (failure.kind === 'reviewer_rejection') handoff('the reviewer rejected the script');
      store.updateTask(runId, taskId, { status: 'recovering' });
    }
    store.append({ runId, taskId, action: 'validate', cause: `the output matches the ${task.role} schema`, result: 'valid' });
    store.updateTask(runId, taskId, { status: 'done', output });

    // A rejection is a failure of the script task. The scheduler starts only after a pass.
    if (task.role === 'reviewer') {
      const { reviews } = output as z.infer<typeof roles.reviewer.output>;
      const rejected = reviews.filter((r) => r.verdict === 'reject');
      const scriptTask = deps.find((d) => d.role === 'script');
      const scriptTaskId = scriptTask?.id ?? taskId;
      if (rejected.length) {
        const detail = rejected.map((r) => `${r.script_id}: ${r.issues.join(' ')}`).join('; ');
        store.append({ runId, taskId: scriptTaskId, action: 'review', cause: detail, result: 'rejected', data: { reviews } });
        store.updateTask(runId, scriptTaskId, { status: 'rejected' });
        // A review for a peer has no script task in this run: nothing can be written again.
        if (!scriptTask) {
          endRun(runId, 'escalated', `the reviewer rejected ${scriptTaskId}`);
          return 'escalated';
        }
        // The script task starts again with the issues and hints in its input, and the review waits for it again.
        const reviewer_hints = rejected.map(({ script_id, issues, hints }) => ({ script_id, issues, hints }));
        store.updateTask(runId, scriptTaskId, { input: { ...(scriptTask.input as object), reviewer_hints } });
        store.updateTask(runId, taskId, { status: 'waiting_on_dependency' });
        mind.history[taskId] = [];
        mind.rejection = { taskId: scriptTaskId, failure: { kind: 'reviewer_rejection', detail } };
        return 'done';
      }
      store.append({ runId, taskId: scriptTaskId, action: 'review', cause: 'the reviewer passed every script', result: 'pass' });
    }
    return 'done';
  }

  return { startRun, startPeerTask, startTask };
}

const isWaiting = (status: string) => status === 'queued' || status === 'waiting_on_dependency';

/** The stored status of a task after each failure. */
const failedStatus: Record<Failure['kind'], TaskStatus> = {
  timeout: 'stalled_timeout',
  missed_heartbeat: 'stalled_heartbeat',
  invalid_output: 'failed_validation',
  model_unavailable: 'model_unavailable',
  rate_limited: 'model_unavailable',
  reviewer_rejection: 'rejected',
};

/** The event action that finds each failure. */
const failureAction: Record<Failure['kind'], string> = {
  timeout: 'watch',
  missed_heartbeat: 'watch',
  invalid_output: 'validate',
  model_unavailable: 'model_call',
  rate_limited: 'model_call',
  reviewer_rejection: 'review',
};
