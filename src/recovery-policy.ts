/** The typed failures of one attempt of an agent. */
export type Failure = {
  kind: 'timeout' | 'missed_heartbeat' | 'invalid_output' | 'model_unavailable' | 'rate_limited' | 'reviewer_rejection' | 'peer_failed';
  /** Plain words for the event log. */
  detail: string;
  /** The raw text behind `detail`, when `detail` is a plain sentence made from it. It goes into the event data. */
  raw?: string;
  /** Only for `rate_limited`: the wait that the model asked for. */
  retryAfterMs?: number;
  /** True when the attempt ran on the owner's backup model. The conductor sets it. */
  onBackup?: boolean;
  /** True when the attempt was step 3: the task was with a peer's agent, or no peer could take it. The conductor sets it. */
  onPeer?: boolean;
  /** Only for an attempt at a peer: the peer did not take the task (it refused, it is over its limit, or it cannot be reached). The peer agent sets it. */
  fast?: boolean;
  /** True when the attempt was step 4: the full goal was with a peer. The conductor sets it. Such a failure also has `onPeer`. */
  onGoal?: boolean;
};

export type Action =
  /** Step 1: `retry` 1 is the first retry; `of` is the hard limit. */
  | { do: 'retry'; retry: number; of: number; waitMs: number }
  /** Step 2: the same task, with the same input, on the owner's backup model. `cause` says why the primary model is left. */
  | { do: 'backup'; cause: string }
  /** Step 3: the same task, with the same input, to the same agent in a peer's Tuloy. */
  | { do: 'peer'; cause: string }
  /** Step 4: the full goal to a peer, one time. The task graph gets a new version with one task. */
  | { do: 'goal'; cause: string }
  /** Step 5. */
  | { do: 'escalate'; cause: string };

export type RetryLimits = { retries: number; retryWaitMs: number };

/** One step of the recovery order. It returns its action, or null when it does not apply and the order continues. */
type Step = (failure: Failure, history: Failure[], limits: RetryLimits, work: Work) => Action | null;

/**
 * What the steps for peers need to know. Work that came from a peer never uses steps 3 and 4.
 * `peers` is the number of peers on the allowed list: with none, steps 3 and 4 have nobody to ask, and the order continues.
 */
export type Work = { forPeer: boolean; peers: number };

/** Step 1: retry the owner's own agent, with a longer wait each time, up to the limit. A known model outage skips this step. */
const retryOwnAgent: Step = (failure, history, { retries, retryWaitMs }) => {
  if (failure.kind === 'model_unavailable' || failure.onBackup || failure.onPeer || history.length >= retries) return null;
  const waitMs = retryWaitMs * 2 ** history.length;
  // A rate-limit answer is honoured: the wait is never shorter than the model asked for.
  return { do: 'retry', retry: history.length + 1, of: retries, waitMs: Math.max(waitMs, failure.retryAfterMs ?? 0) };
};

/** Step 2: re-route to the owner's backup model, one time. The backup model gets one attempt. */
const rerouteToBackup: Step = (failure, history, { retries }) => {
  if (failure.onBackup || failure.onPeer || history.some((f) => f.onBackup)) return null;
  return { do: 'backup', cause: failure.kind === 'model_unavailable' ? 'primary outage' : `${history.length} of ${retries} retries used` };
};

/**
 * Step 3: re-route to the same agent in a peer's Tuloy. It applies when the backup model failed also.
 * When the first peer does not take the task (a fast failure), the next peer on the allowed list is asked: two peers at most.
 * Every other failure with `onPeer` is the result 'the peer step failed': a silent peer is not followed by a second peer.
 */
const rerouteToPeer: Step = (failure, history, _limits, { forPeer, peers }) => {
  const asked = [failure, ...history].filter((f) => f.onPeer).length;
  if (forPeer || failure.onGoal || asked >= Math.min(2, peers) || (asked === 1 && !failure.fast)) return null;
  return { do: 'peer', cause: asked ? 'the first peer did not take the task' : 'the backup model also failed' };
};

/**
 * Step 4: give the full goal to a peer, one time. It applies when the peer step failed.
 * A failure with `onGoal` is the failure of this step, so the goal is given at most one time per run.
 */
const giveGoalToPeer: Step = (failure, history, _limits, { forPeer, peers }) => {
  if (forPeer || peers === 0 || failure.onGoal || !(failure.onPeer || history.some((f) => f.onPeer))) return null;
  return { do: 'goal', cause: 'the re-route to a peer failed' };
};

/** Step 5: end the run as escalated. It always applies. */
const escalate: Step = (failure) => ({ do: 'escalate', cause: failure.onGoal ? 'every path failed' : failure.onPeer ? 'the re-route to a peer failed' : 'the backup model also failed' });

/** The agreed recovery order. */
const order: Step[] = [retryOwnAgent, rerouteToBackup, rerouteToPeer, giveGoalToPeer, escalate];

/**
 * The recovery policy: (failure, the earlier failures of this task in this run, whose work it is) → next action.
 * Pure: no clock, no model, no store. It contains the recovery order and nothing else.
 */
export function nextAction(failure: Failure, history: Failure[], limits: RetryLimits, work: Work = { forPeer: false, peers: 0 }): Action {
  for (const step of order) {
    const action = step(failure, history, limits, work);
    if (action) return action;
  }
  throw new Error('the recovery order has no last step');
}
