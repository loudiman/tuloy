import { expect, test } from 'vitest';
import { nextAction, type Failure } from '../src/recovery-policy.ts';

const limits = { retries: 2, retryWaitMs: 2000 };
const fail = (kind: Failure['kind']): Failure => ({ kind, detail: 'x' });
const onBackup = (kind: Failure['kind']): Failure => ({ kind, detail: 'x', onBackup: true });
const onPeer = (kind: Failure['kind']): Failure => ({ kind, detail: 'x', onPeer: true });
const peer = { do: 'peer', cause: 'the backup model also failed' };
const escalate = (cause: string) => ({ do: 'escalate', cause });
const own = { forPeer: false, peers: 1 };

// Step 3 of the recovery order: (failure, the earlier failures of this task, whose work it is) → next action
test.each([
  ['the backup model also failed: the task is re-routed to a peer', onBackup('model_unavailable'), [fail('model_unavailable')], own, peer],
  ['a bad output of the backup model after the retries also goes to a peer', onBackup('invalid_output'), [fail('timeout'), fail('timeout'), fail('timeout')], own, peer],
  ['a peer that refuses or fails: the peer step failed, the run is escalated', onPeer('peer_failed'), [fail('model_unavailable'), onBackup('model_unavailable')], own, escalate('the re-route to a peer failed')],
  ['a silent peer is not retried and not sent to the backup model again', onPeer('timeout'), [fail('model_unavailable'), onBackup('model_unavailable')], own, escalate('the re-route to a peer failed')],
  ['a bad payload from a peer is a failure of the peer step', onPeer('invalid_output'), [fail('model_unavailable'), onBackup('model_unavailable')], own, escalate('the re-route to a peer failed')],
  ['work that came from a peer is never sent to another peer', onBackup('model_unavailable'), [fail('model_unavailable')], { forPeer: true, peers: 1 }, escalate('the backup model also failed')],
  ['with an empty allowed list the peer step has nobody to ask, and the order continues', onBackup('model_unavailable'), [fail('model_unavailable')], { forPeer: false, peers: 0 }, escalate('the backup model also failed')],
] as const)('%s', (_name, failure, history, work, action) => {
  expect(nextAction(failure, [...history], limits, work)).toEqual(action);
});
