/** The typed failures of one attempt of an agent. */
export type Failure = {
  kind: 'timeout' | 'missed_heartbeat' | 'invalid_output' | 'model_unavailable' | 'rate_limited' | 'reviewer_rejection';
  /** Plain words for the event log. */
  detail: string;
  /** Only for `rate_limited`: the wait that the model asked for. */
  retryAfterMs?: number;
};

export type Action =
  /** Step 1: `retry` 1 is the first retry; `of` is the hard limit. */
  | { do: 'retry'; retry: number; of: number; waitMs: number }
  /** Step 5. */
  | { do: 'escalate'; cause: string };

export type RetryLimits = { retries: number; retryWaitMs: number };

/** One step of the recovery order. It returns its action, or null when it does not apply and the order continues. */
type Step = (failure: Failure, history: Failure[], limits: RetryLimits) => Action | null;

/** Step 1: retry the owner's own agent, with a longer wait each time, up to the limit. A known model outage skips this step. */
const retryOwnAgent: Step = (failure, history, { retries, retryWaitMs }) => {
  if (failure.kind === 'model_unavailable' || history.length >= retries) return null;
  const waitMs = retryWaitMs * 2 ** history.length;
  // A rate-limit answer is honoured: the wait is never shorter than the model asked for.
  return { do: 'retry', retry: history.length + 1, of: retries, waitMs: Math.max(waitMs, failure.retryAfterMs ?? 0) };
};

/** Step 5: end the run as escalated. It always applies. */
const escalate: Step = (failure, history, { retries }) => ({
  do: 'escalate',
  cause: failure.kind === 'model_unavailable' ? 'a model outage is not retried' : `${history.length} of ${retries} retries used`,
});

/** The agreed recovery order. Steps 2 (backup model), 3 (a peer's agent) and 4 (the full goal to a peer) go between these two. */
const order: Step[] = [retryOwnAgent, escalate];

/**
 * The recovery policy: (failure, the earlier failures of this task in this run) → next action.
 * Pure: no clock, no model, no store. It contains the recovery order and nothing else.
 */
export function nextAction(failure: Failure, history: Failure[], limits: RetryLimits): Action {
  for (const step of order) {
    const action = step(failure, history, limits);
    if (action) return action;
  }
  throw new Error('the recovery order has no last step');
}
