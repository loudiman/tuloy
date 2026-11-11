import { expect, test } from 'vitest';
import { nextAction, type Failure } from '../src/recovery-policy.ts';

const limits = { retries: 2, retryWaitMs: 2000 };
const fail = (kind: Failure['kind'], retryAfterMs?: number): Failure => ({ kind, detail: 'x', retryAfterMs });
const onBackup = (kind: Failure['kind']): Failure => ({ kind, detail: 'x', onBackup: true });
const backup = (cause: string) => ({ do: 'backup', cause });
const retry = (retry: number, waitMs: number) => ({ do: 'retry', retry, of: 2, waitMs });
const escalate = (cause: string) => ({ do: 'escalate', cause });

// (failure, the earlier failures of this task) → next action
test.each([
  ['a first timeout is retried after 2 s', fail('timeout'), [], retry(1, 2000)],
  ['a first missed heartbeat is retried after 2 s', fail('missed_heartbeat'), [], retry(1, 2000)],
  ['a first invalid output is retried after 2 s', fail('invalid_output'), [], retry(1, 2000)],
  ['the second retry waits longer: 4 s', fail('timeout'), [fail('invalid_output')], retry(2, 4000)],
  ['after the last retry the task is re-routed to the backup model', fail('timeout'), [fail('timeout'), fail('timeout')], backup('2 of 2 retries used')],
  ['a rate limit waits as long as the model asks', fail('rate_limited', 7000), [], retry(1, 7000)],
  ['a rate limit never waits less than the usual wait', fail('rate_limited', 500), [fail('timeout')], retry(2, 4000)],
  ['a rate limit with no time waits the usual wait', fail('rate_limited'), [], retry(1, 2000)],
  ['a rate limit also stops at the hard limit', fail('rate_limited', 7000), [fail('rate_limited'), fail('rate_limited')], backup('2 of 2 retries used')],
  ['a model outage skips the retries and goes to the backup model', fail('model_unavailable'), [], backup('primary outage')],
  ['an outage after a retry also goes to the backup model', fail('model_unavailable'), [fail('timeout')], backup('primary outage')],
  ['an outage of the backup model also: backup failed, the run is escalated', onBackup('model_unavailable'), [fail('model_unavailable')], escalate('the backup model also failed')],
  ['a failure on the backup model is not retried', onBackup('invalid_output'), [fail('model_unavailable')], escalate('the backup model also failed')],
  ['the backup model is used one time', onBackup('timeout'), [fail('timeout'), fail('timeout'), fail('timeout')], escalate('the backup model also failed')],
] as const)('%s', (_name, failure, history, action) => {
  expect(nextAction(failure, [...history], limits)).toEqual(action);
});

test('with a limit of 0 retries the first failure goes to the backup model', () => {
  expect(nextAction(fail('timeout'), [], { retries: 0, retryWaitMs: 2000 })).toEqual(backup('0 of 0 retries used'));
});
