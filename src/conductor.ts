import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import { runAgent } from './agent-runner.ts';
import type { Clock } from './clock.ts';
import { peerAgentName, runPeerAgent } from './peer-agent.ts';
import { createPeerClient, type A2aClient } from './peer-client.ts';
import { planTaskGraph } from './planner.ts';
import { nextAction, type Failure } from './recovery-policy.ts';
import { roles, type Role } from './schemas.ts';
import type { Limits } from './settings.ts';
import type { Peer, Store, TaskStatus } from './store.ts';

export type Conductor = ReturnType<typeof createConductor>;

/**
 * The conductor owns a run from the goal to its end. Read what it did from the store: the task rows and the event log.
 * Recovery: a failed or stalled task goes to the recovery policy; the conductor does the action that the policy returns.
 * ponytail: in one run, tasks start one at a time (the template graph never has two ready tasks). Runs go side by side.
 */
export function createConductor({
  store,
  models,
  clock,
  limits,
  peerClient = createPeerClient(),
}: {
  store: Store;
  models: { primary: LanguageModel; backup: LanguageModel };
  clock: Clock;
  limits: Limits;
  /** Sends a task to a peer (step 3 of the recovery order). The default refuses private and same-machine addresses. */
  peerClient?: A2aClient;
}) {
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

  /**
   * Continues every run that was not finished when Tuloy stopped. Call it one time at start-up, before new work comes in.
   * A task that was in the middle of its work at the stop is treated as stalled and goes through recovery. Done tasks are not run again.
   */
  function continueRuns(): { runId: number; ended: Promise<void> }[] {
    return store
      .runs()
      .filter((run) => run.status === 'running')
      .reverse()
      .map((run) => {
        store.append({ runId: run.id, action: 'restart', cause: 'Tuloy started again before this run ended', result: 'continued' });
        return { runId: run.id, ended: drive(run.id, true) };
      });
  }

  async function drive(runId: number, afterRestart = false): Promise<void> {
    try {
      if (afterRestart) {
        for (const task of store.tasks(runId)) if (!isWaiting(task.status) && task.status !== 'done') await startTask(runId, task.id, true);
      }
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
  async function startTask(runId: number, taskId: string, afterRestart = false): Promise<'done' | 'rejected' | 'escalated'> {
    const run = store.run(runId);
    const tasks = store.tasks(runId);
    const task = tasks.find((t) => t.id === taskId);
    if (!run || !task) throw new Error(`no task ${taskId} in run ${runId}`);
    const deps = task.dependsOn.map((id) => tasks.find((t) => t.id === id)!);
    const notDone = deps.filter((d) => d.status !== 'done').map((d) => d.id);
    const why = notDone.length ? `it depends on ${notDone.join(', ')}, not done yet` : !isWaiting(task.status) && !afterRestart ? `the task is ${task.status}` : run.status !== 'running' ? `the run is ${run.status}` : null;
    if (why) {
      store.append({ runId, taskId, action: 'dispatch', cause: why, result: 'rejected' });
      return 'rejected';
    }

    if (!afterRestart) {
      const agent = task.role;
      store.updateTask(runId, taskId, { agent, status: 'running' });
      store.append({ runId, taskId, action: 'assign', cause: 'the task is ready', result: agent, data: { model: 'primary' } });
    }

    // The next agent gets only the checked fields of its role's input schema.
    const input = roles[task.role].input.parse(Object.assign({ goal: run.goal }, task.input, ...deps.map((d) => d.output)));
    if (deps.length && !afterRestart) {
      store.append({ runId, taskId, action: 'handoff', cause: `${deps.map((d) => d.id).join(', ')} done`, result: 'checked content stored', data: { from: deps.map((d) => d.id), content: input } });
    }
    // One turn of this loop is one attempt. The earlier failures of the task are the history for the recovery policy.
    // After a restart they come from the event log, so that a restart does not give the task new retries.
    const mine = afterRestart ? store.events(runId).filter((e) => e.taskId === taskId) : [];
    const rerouted = mine.findLast((e) => e.action === 'reroute')?.seq;
    const history: Failure[] = mine
      .filter((e) => e.result in failureAction && e.action === failureAction[e.result as Failure['kind']])
      .map((e) => ({ kind: e.result as Failure['kind'], detail: e.cause, onBackup: rerouted !== undefined && e.seq > rerouted }));
    let output: unknown;
    // The backup model is in use from the `reroute` event on. After a restart that also comes from the event log.
    let model: 'primary' | 'backup' | 'peer' = rerouted !== undefined ? 'backup' : 'primary';
    // Step 3: the peer that has the task.
    let peer: Peer | undefined;
    let allDown: string | undefined;
    // After a restart the first turn makes no attempt: the stop is the failure, and recovery starts from it.
    let stopped: Failure | null = afterRestart ? { kind: 'missed_heartbeat', detail: 'Tuloy restarted while the task was in work' } : null;
    for (;;) {
      const why = peer ? `re-routed to ${peerAgentName(peer, task.role)}` : model === 'backup' ? 're-routed to the backup model' : history.length ? `retry ${history.length} of ${limits.retries}` : 'the tasks it depends on are done';
      if (!stopped) store.append({ runId, taskId, action: 'dispatch', cause: why, result: 'started' });
      // Demo mode: a pending injection for this agent is used now, one time. Injections act on the primary model;
      // only an outage of all own models goes with the task to the backup model.
      const injected = stopped || model === 'peer' ? undefined : model === 'primary' ? store.takeInjection(task.role) : allDown;
      if (injected === 'all_models_outage') allDown = injected;
      if (injected && model === 'primary') store.append({ runId, taskId, action: 'injection', cause: 'demo: the presenter injected this failure', result: injected });
      // The time limit starts when the agent has its slot, not while it waits in line.
      const heartbeat = (cause: string) => () => void store.append({ runId, taskId, action: 'heartbeat', cause, result: 'alive' });
      const result = stopped
        ? { ok: false as const, failure: stopped }
        : peer
          ? await runPeerAgent(task.role, input, peer, peerClient, { clock, limits, onHeartbeat: heartbeat(`${peer.name}'s Tuloy answered: the task is in work`) })
          : await withModelSlot(() => runAgent(task.role, input, models[model === 'backup' ? 'backup' : 'primary'], { clock, limits, injected, onHeartbeat: heartbeat('the agent waits for the model') }));
      stopped = null;
      if (result.ok) {
        output = result.output;
        break;
      }
      const failure: Failure = { ...result.failure, onBackup: model === 'backup', onPeer: model === 'peer' };
      store.append({ runId, taskId, action: failureAction[failure.kind], cause: failure.detail, result: failure.kind });
      store.updateTask(runId, taskId, { status: failedStatus[failure.kind] });

      const action = nextAction(failure, history, limits, { forPeer: run.forPeer !== null, peers: store.peers().length });
      if (action.do === 'escalate') {
        store.append({ runId, taskId, action: 'escalate', cause: action.cause, result: 'escalated' });
        store.updateTask(runId, taskId, { status: 'escalated' });
        endRun(runId, 'escalated', `${taskId} failed: ${failure.kind}`);
        return 'escalated';
      }
      if (action.do === 'backup') {
        // Step 2: the same checked input goes to the backup model. The switch is one event.
        store.append({ runId, taskId, action: 'reroute', cause: action.cause, result: 'backup model', data: action });
        model = 'backup';
      } else if (action.do === 'peer') {
        // Step 3: the same checked input goes to the same agent of a peer. ponytail: the first peer of the allowed list gets it; try the others in turn when one peer is not enough.
        peer = store.peers()[0]!;
        model = 'peer';
        const agent = peerAgentName(peer, task.role);
        store.append({ runId, taskId, action: 'reroute', cause: action.cause, result: agent, data: { ...action, peer: peer.name } });
        store.updateTask(runId, taskId, { agent });
      } else {
        store.append({ runId, taskId, action: 'retry', cause: failure.kind, result: 'waiting', data: action });
        await clock.sleep(action.waitMs);
        if (store.run(runId)?.status !== 'running') return 'escalated';
      }
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

  return { startRun, startPeerTask, startTask, continueRuns };
}

const isWaiting = (status: string) => status === 'queued' || status === 'waiting_on_dependency';

/** The stored status of a task after each failure. */
const failedStatus: Record<Failure['kind'], TaskStatus> = {
  timeout: 'stalled_timeout',
  missed_heartbeat: 'stalled_heartbeat',
  invalid_output: 'failed_validation',
  model_unavailable: 'model_unavailable',
  rate_limited: 'model_unavailable',
  // The stored statuses have no word for a peer. The owner's models are down and no peer finished the task.
  peer_failed: 'model_unavailable',
};

/** The event action that finds each failure. */
const failureAction: Record<Failure['kind'], string> = {
  timeout: 'watch',
  missed_heartbeat: 'watch',
  invalid_output: 'validate',
  model_unavailable: 'model_call',
  rate_limited: 'model_call',
  peer_failed: 'peer_call',
};
