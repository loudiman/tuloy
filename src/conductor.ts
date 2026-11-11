import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import { runAgent, type AgentResult, type Outside } from './agent-runner.ts';
import type { Clock } from './clock.ts';
import { peerAgentName, runPeerAgent } from './peer-agent.ts';
import { createPeerClient, type A2aClient } from './peer-client.ts';
import { planTaskGraph } from './planner.ts';
import { nextAction, type Failure } from './recovery-policy.ts';
import { skills, type Role } from './schemas.ts';
import type { Limits } from './settings.ts';
import type { Peer, Store, Task, TaskStatus } from './store.ts';

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
  demo = false,
}: {
  store: Store;
  models: { primary: LanguageModel; backup: LanguageModel };
  clock: Clock;
  limits: Limits;
  /** Sends a task to a peer (step 3 of the recovery order). The default refuses private and same-machine addresses. */
  peerClient?: A2aClient;
  /** Demo mode. Outside demo mode no injection acts, also not one that an earlier start in demo mode left in the data file. */
  demo?: boolean;
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

  /** A reviewer rejection that waits for recovery: the rejection is the last event of the task, so no retry and no escalation came after it. */
  function pendingRejection(runId: number, task: Task): Failure | undefined {
    if (task.status !== 'rejected') return undefined;
    const last = store.events(runId).findLast((e) => e.taskId === task.id);
    return last?.action === 'review' && last.result === 'rejected' ? { kind: 'reviewer_rejection', detail: last.cause } : undefined;
  }

  /**
   * Stores the task graph and starts the run. `ended` resolves when the run is done or escalated; it never rejects.
   * `forPeer` is the name of the peer that gave the full goal; such a run never uses steps 3 and 4 of the recovery order.
   */
  function startRun(goal: string, forPeer: string | null = null): { runId: number; ended: Promise<void> } {
    const tasks = planTaskGraph(goal);
    const runId = store.createRun(goal, tasks, forPeer);
    store.append({ runId, action: 'plan', cause: forPeer ? `${forPeer} gave a full goal` : 'the owner gave a goal', result: `task graph stored: ${tasks.length} tasks`, data: forPeer ? { peer: forPeer } : undefined });
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
        const next = tasks.find((t) => (isWaiting(t.status) || pendingRejection(runId, t)) && t.dependsOn.every((d) => tasks.find((x) => x.id === d)?.status === 'done'));
        if (!next) return endRun(runId, 'done', 'all tasks are done');
        await startTask(runId, next.id);
      }
    } catch (error) {
      endRun(runId, 'escalated', `the conductor hit an error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Stops a run that is not finished: the peer that asked for the work cancelled it. The run ends as escalated with `cause`.
   * No model call starts for the run after this. ponytail: a model call that is in flight is not stopped; its answer is dropped.
   */
  function cancelRun(runId: number, cause: string) {
    if (store.run(runId)?.status !== 'running') return;
    for (const task of store.tasks(runId)) {
      if (isWaiting(task.status) || task.status === 'done') continue;
      store.append({ runId, taskId: task.id, action: 'escalate', cause, result: 'escalated' });
      store.updateTask(runId, task.id, { status: 'escalated' });
    }
    endRun(runId, 'escalated', cause);
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
    // A script that the reviewer rejected starts again here: the rejection is its failure, and the loop below recovers from it.
    const rejection = pendingRejection(runId, task);
    const why = notDone.length ? `it depends on ${notDone.join(', ')}, not done yet` : !isWaiting(task.status) && !afterRestart && !rejection ? `the task is ${task.status}` : run.status !== 'running' ? `the run is ${run.status}` : null;
    if (why) {
      store.append({ runId, taskId, action: 'dispatch', cause: why, result: 'rejected' });
      return 'rejected';
    }

    const fresh = !afterRestart && !rejection;
    // Step 3: the peer that has the task. Step 4: the one task of the new task graph version is the full goal, and a peer's conductor has it from the start.
    let peer: Peer | undefined = task.role === 'goal' ? store.peers()[0] : undefined;
    if (fresh) {
      const agent = peer ? peerAgentName(peer, task.role) : task.role;
      store.updateTask(runId, taskId, { agent, status: 'running' });
      store.append({ runId, taskId, action: 'assign', cause: 'the task is ready', result: agent, data: peer ? { peer: peer.name } : { model: 'primary' } });
    }

    // The next agent gets only the checked fields of its role's input schema.
    const input = skills[task.role].input.parse(Object.assign({ goal: run.goal }, task.input, ...deps.map((d) => d.output)));
    const handoff = (cause: string) => deps.length && store.append({ runId, taskId, action: 'handoff', cause, result: 'checked content stored', data: { from: deps.map((d) => d.id), content: input } });
    if (fresh) handoff(`${deps.map((d) => d.id).join(', ')} done`);
    // A task that a peer's agent finished has a `reroute` event with the peer. Its output is outside text for the next agent.
    const outside: Outside[] = deps.flatMap((d) => {
      const from = (store.events(runId).findLast((e) => e.taskId === d.id && e.action === 'reroute')?.data as { peer?: string } | null)?.peer;
      return from ? [{ from, task: d.id, keys: Object.keys(d.output as object) }] : [];
    });
    // Hints that a peer's reviewer wrote are outside text for the script agent.
    const hintsFrom = (task.input as { hints_from?: string } | null)?.hints_from;
    if (hintsFrom) outside.push({ from: hintsFrom, task: tasks.find((t) => t.role === 'reviewer')?.id ?? taskId, keys: ['reviewer_hints'] });
    // What a peer sent is outside text too: the goal of a run for a peer, and the whole input of one task that a peer sent.
    if (run.forPeer) outside.push({ from: run.forPeer, task: taskId, keys: ['goal', ...(deps.length ? [] : Object.keys((task.input ?? {}) as object))] });
    // One turn of this loop is one attempt. The earlier failures of the task are the history for the recovery policy.
    // After a restart or a rejection they come from the event log, so that neither gives the task new retries.
    const mine = fresh ? [] : store.events(runId).filter((e) => e.taskId === taskId);
    const reroutes = mine.filter((e) => e.action === 'reroute');
    const rerouted = reroutes[0]?.seq;
    // A `reroute` event with a peer in its data: the task was with that peer's agent from there on.
    const toPeer = reroutes.find((e) => (e.data as { peer?: string } | null)?.peer)?.seq;
    const history: Failure[] = mine.flatMap((e) => {
      const kind = e.action === 'review' && e.result === 'rejected' ? 'reviewer_rejection' : e.result in failureAction && e.action === failureAction[e.result as Failure['kind']] ? (e.result as Failure['kind']) : null;
      const onPeer = toPeer !== undefined && e.seq > toPeer;
      return kind ? [{ kind, detail: e.cause, onBackup: rerouted !== undefined && e.seq > rerouted && !onPeer, onPeer }] : [];
    });
    if (rejection) history.pop(); // the rejection in work now is not an earlier failure
    let output: unknown;
    // The backup model, or a peer, has the task from its `reroute` event on. After a restart or a rejection that also comes from the event log.
    let model: 'primary' | 'backup' | 'peer' = toPeer !== undefined || task.role === 'goal' ? 'peer' : rerouted !== undefined ? 'backup' : 'primary';
    let allDown: string | undefined;
    // After a restart or a rejection the first turn makes no attempt: the stop or the rejection is the failure, and recovery starts from it.
    let stopped: Failure | null = rejection
      ? rejection
      : afterRestart
        ? { kind: 'missed_heartbeat', detail: 'Tuloy restarted while the task was in work' }
        : task.role === 'goal' && !peer
          ? { kind: 'peer_failed', detail: 'no peer is on the allowed list' }
          : null;
    for (;;) {
      const why = task.role === 'goal' ? `the full goal goes to ${task.agent ?? 'a peer'}` : peer ? `re-routed to ${peerAgentName(peer, task.role)}` : model === 'backup' ? 're-routed to the backup model' : history.length ? `retry ${history.length} of ${limits.retries}` : 'the tasks it depends on are done';
      if (!stopped) store.append({ runId, taskId, action: 'dispatch', cause: why, result: 'started' });
      // Demo mode: a pending injection for this agent is used now, one time. Injections act on the primary model;
      // only an outage of all own models goes with the task to the backup model. The kinds for a peer act on the peer step.
      // An injection acts only on the owner's own runs: a run for a peer never takes one.
      const injected = stopped || !demo || run.forPeer !== null ? undefined : model === 'backup' ? allDown : store.takeInjection(task.role, model === 'peer');
      if (injected === 'all_models_outage') allDown = injected;
      if (injected && model !== 'backup') store.append({ runId, taskId, action: 'injection', cause: 'demo: the presenter injected this failure', result: injected });
      // An injected rejection of the script acts in the review of that script: the script agent hands it to the reviewer.
      if (injected === 'reviewer_rejection' && task.role === 'script') store.addInjection('reviewer', injected);
      // The time limit starts when the agent has its slot, not while it waits in line.
      // No heartbeat is written for a run that ended while the agent worked (a cancel).
      const heartbeat = (cause: string) => () => void (store.run(runId)?.status === 'running' && store.append({ runId, taskId, action: 'heartbeat', cause, result: 'alive' }));
      let result: AgentResult = stopped
        ? { ok: false as const, failure: stopped }
        : peer || task.role === 'goal'
          ? await runPeerAgent(task.role, input, peer!, peerClient, {
              clock,
              // ponytail: the peer does a full run for a goal, so the time limit is one task time limit for each task of the template graph.
              limits: task.role === 'goal' ? { ...limits, taskTimeLimitMs: limits.taskTimeLimitMs * planTaskGraph(run.goal).length } : limits,
              injected,
              onHeartbeat: heartbeat(`${peer!.name}'s Tuloy answered: the task is in work`),
            })
          : await withModelSlot(async () =>
              // The run can end while the agent waits in line (a cancel): then no model call starts.
              store.run(runId)?.status !== 'running'
                ? { ok: false as const, failure: { kind: 'timeout' as const, detail: 'the run ended' } }
                : runAgent(task.role as Role, input, models[model === 'backup' ? 'backup' : 'primary'], { clock, limits, injected, outside, onHeartbeat: heartbeat('the agent waits for the model') }),
            );
      stopped = null;
      // The run ended while the agent worked (a cancel): its answer is dropped, and nothing more is written or started.
      if (store.run(runId)?.status !== 'running') return 'escalated';
      // A review must name every script. A script with no review has no pass, so the review is a bad output of the reviewer.
      if (result.ok && task.role === 'reviewer') {
        const { reviews } = result.output as z.infer<typeof skills.reviewer.output>;
        const noReview = (input as z.infer<typeof skills.reviewer.input>).scripts.filter((s) => !reviews.some((r) => r.script_id === s.id));
        if (noReview.length) result = { ok: false, failure: { kind: 'invalid_output', detail: `The output has no review of script ${noReview.map((s) => s.id).join(', ')}.` } };
      }
      if (result.ok) {
        output = result.output;
        break;
      }
      const failure: Failure = { ...result.failure, onBackup: model === 'backup', onPeer: model === 'peer', onGoal: task.role === 'goal' };
      // The `review` event of a rejection is in the log already.
      if (failure.kind !== 'reviewer_rejection')
        store.append({ runId, taskId, action: failureAction[failure.kind], cause: failure.detail, result: failure.kind, data: failure.raw ? { detail: failure.raw } : undefined });
      store.updateTask(runId, taskId, { status: failedStatus[failure.kind] });

      const action = nextAction(failure, history, limits, { forPeer: run.forPeer !== null, peers: store.peers().length });
      if (action.do === 'escalate') {
        // Step 5 after step 4: the cause names every path that was tried, so that the stuck reason does too.
        const given = task.role === 'goal' ? (store.events(runId).find((e) => e.action === 'goal_to_peer')?.data as { peer: string; tried: string[] } | undefined) : undefined;
        const cause = given ? `${action.cause}: ${[...given.tried, `the full goal to ${given.peer}`].join(', ')}` : action.cause;
        store.append({ runId, taskId, action: 'escalate', cause, result: 'escalated' });
        store.updateTask(runId, taskId, { status: 'escalated' });
        endRun(runId, 'escalated', `${taskId} failed: ${failure.kind}`);
        return 'escalated';
      }
      if (action.do === 'goal') {
        // Step 4: the full goal goes to a peer, one time. The task graph gets a new version with one task; `drive` starts it.
        // ponytail: the first peer of the allowed list gets it, as in step 3.
        const to = store.peers()[0]!;
        const tried = store.events(runId).filter((e) => e.taskId === taskId);
        const retries = tried.filter((e) => e.action === 'retry').length;
        const paths = [
          `the own ${task.role.replace('_', ' ')} agent`,
          ...(retries ? [`${retries} ${retries === 1 ? 'retry' : 'retries'}`] : []),
          ...tried.filter((e) => e.action === 'reroute').map((e) => (e.result === 'backup model' ? 'the backup model' : e.result)),
        ];
        store.append({ runId, taskId, action: 'goal_to_peer', cause: action.cause, result: to.name, data: { ...action, peer: to.name, tried: paths } });
        store.updateTask(runId, taskId, { status: 'escalated' });
        const version = store.newTaskGraph(runId, [{ id: 'goal', title: `Give the full goal to ${to.name}`, dependsOn: [], role: 'goal' }]);
        store.append({ runId, action: 'plan', cause: `the full goal goes to ${to.name}`, result: `task graph version ${version} stored: 1 task` });
        return 'escalated';
      }
      if (action.do === 'backup') {
        // Step 2: the same checked input goes to the backup model. The switch is one event.
        store.append({ runId, taskId, action: 'reroute', cause: action.cause, result: 'backup model', data: action });
        model = 'backup';
      } else if (action.do === 'peer') {
        // Step 3: the same checked input goes to the same agent of a peer: the first peer of the allowed list that this task did not ask yet.
        const asked = store.events(runId).flatMap((e) => (e.taskId === taskId && e.action === 'reroute' ? [(e.data as { peer?: string } | null)?.peer] : []));
        peer = store.peers().find((p) => !asked.includes(p.name)) ?? store.peers()[0]!;
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
      // The input of this retry is new: it has the reviewer's issues and hints.
      if (failure.kind === 'reviewer_rejection') handoff('the reviewer rejected the script');
      store.updateTask(runId, taskId, { status: 'recovering' });
    }
    // The writes of a rejection are one transaction: a stop cannot leave a review task that is done without the rejection that it found.
    const rejects = task.role === 'reviewer' && (output as z.infer<typeof skills.reviewer.output>).reviews.some((r) => r.verdict === 'reject');
    const fromPeer = model === 'peer' ? peer?.name : undefined;
    return rejects ? store.transaction(() => finish(runId, task, deps, output, fromPeer)) : finish(runId, task, deps, output, fromPeer);
  }

  /**
   * The writes at the end of a task that gave a valid output. For the reviewer: the pass, or the rejection of the script task.
   * `fromPeer` is the peer whose agent gave the output, when the task was re-routed to a peer.
   */
  function finish(runId: number, task: Task, deps: Task[], output: unknown, fromPeer?: string): 'done' {
    const taskId = task.id;
    store.append({ runId, taskId, action: 'validate', cause: `the output matches the ${task.role} schema`, result: 'valid' });
    store.updateTask(runId, taskId, { status: 'done', output });

    // A rejection is a failure of the script task. The scheduler starts only after every script has a pass.
    if (task.role === 'reviewer') {
      const { reviews } = output as z.infer<typeof skills.reviewer.output>;
      const rejected = reviews.filter((r) => r.verdict === 'reject');
      const scriptTask = deps.find((d) => d.role === 'script');
      const scriptTaskId = scriptTask?.id ?? taskId;
      if (rejected.length) {
        const detail = rejected.map((r) => `${r.script_id}: ${r.issues.join(' ')}`).join('; ');
        store.append({ runId, taskId: scriptTaskId, action: 'review', cause: detail, result: 'rejected', data: { reviews } });
        // A review for a peer has no script task in this run. The rejection is a valid review: the review task is done,
        // and the peer gets the verdict, the issues and the hints as the result, so that its conductor can recover.
        if (!scriptTask) return 'done';
        store.updateTask(runId, scriptTaskId, { status: 'rejected' });
        // The script task starts again with the issues and hints in its input, and the review waits for it again.
        // `hints_from` names the peer whose reviewer wrote them: the script agent then reads them as outside text.
        const reviewer_hints = rejected.map(({ script_id, issues, hints }) => ({ script_id, issues, hints }));
        store.updateTask(runId, scriptTaskId, { input: { ...(scriptTask.input as object), reviewer_hints, hints_from: fromPeer } });
        store.updateTask(runId, taskId, { status: 'waiting_on_dependency' });
        return 'done';
      }
      store.append({ runId, taskId: scriptTaskId, action: 'review', cause: 'the reviewer passed every script', result: 'pass' });
    }
    return 'done';
  }

  return { startRun, startPeerTask, startTask, continueRuns, cancelRun };
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
  reviewer_rejection: 'rejected',
};

/** The event action that finds each failure. */
const failureAction: Record<Failure['kind'], string> = {
  timeout: 'watch',
  missed_heartbeat: 'watch',
  invalid_output: 'validate',
  model_unavailable: 'model_call',
  rate_limited: 'model_call',
  peer_failed: 'peer_call',
  reviewer_rejection: 'review',
};
