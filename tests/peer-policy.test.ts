import { expect, test } from 'vitest';
import { nextAction, type Failure } from '../src/recovery-policy.ts';

const limits = { retries: 2, retryWaitMs: 2000 };
const fail = (kind: Failure['kind']): Failure => ({ kind, detail: 'x' });
const onBackup = (kind: Failure['kind']): Failure => ({ kind, detail: 'x', onBackup: true });
const onPeer = (kind: Failure['kind']): Failure => ({ kind, detail: 'x', onPeer: true });
const peer = { do: 'peer', cause: 'the backup model also failed' };
const goal = { do: 'goal', cause: 'the re-route to a peer failed' };
const escalate = (cause: string) => ({ do: 'escalate', cause });
const own = { forPeer: false, peers: 1 };

// Step 3 of the recovery order: (failure, the earlier failures of this task, whose work it is) → next action
test.each([
  ['the backup model also failed: the task is re-routed to a peer', onBackup('model_unavailable'), [fail('model_unavailable')], own, peer],
  ['a bad output of the backup model after the retries also goes to a peer', onBackup('invalid_output'), [fail('timeout'), fail('timeout'), fail('timeout')], own, peer],
  ['a peer that refuses or fails: the peer step failed, the order continues with the full goal', onPeer('peer_failed'), [fail('model_unavailable'), onBackup('model_unavailable')], own, goal],
  ['a silent peer is not retried and not sent to the backup model again', onPeer('timeout'), [fail('model_unavailable'), onBackup('model_unavailable')], own, goal],
  ['a bad payload from a peer is a failure of the peer step', onPeer('invalid_output'), [fail('model_unavailable'), onBackup('model_unavailable')], own, goal],
  ['work that came from a peer is never sent to another peer', onBackup('model_unavailable'), [fail('model_unavailable')], { forPeer: true, peers: 1 }, escalate('the backup model also failed')],
  ['with an empty allowed list the peer step has nobody to ask, and the order continues', onBackup('model_unavailable'), [fail('model_unavailable')], { forPeer: false, peers: 0 }, escalate('the backup model also failed')],
] as const)('%s', (_name, failure, history, work, action) => {
  expect(nextAction(failure, [...history], limits, work)).toEqual(action);
});

// ---- Review fix 9: a peer that does not take the task (a fast failure) → the next peer, two peers at most ----

const fast = (kind: Failure['kind']): Failure => ({ kind, detail: 'x', onPeer: true, fast: true });
const nextPeer = { do: 'peer', cause: 'the first peer did not take the task' };
const before = [fail('model_unavailable'), onBackup('model_unavailable')];

test.each([
  ['the first peer refuses, is over its limit or cannot be reached: the next peer is asked', fast('peer_failed'), before, { forPeer: false, peers: 2 }, nextPeer],
  ['with one peer on the allowed list there is no next peer', fast('peer_failed'), before, { forPeer: false, peers: 1 }, goal],
  ['two peers at most: when the second does not take the task, the third is not asked', fast('peer_failed'), [...before, fast('peer_failed')], { forPeer: false, peers: 3 }, goal],
  ['a silent peer ends the peer step: the next peer is not asked', onPeer('timeout'), before, { forPeer: false, peers: 2 }, goal],
  ['a peer that took the task and failed ends the peer step', onPeer('peer_failed'), before, { forPeer: false, peers: 2 }, goal],
] as const)('%s', (_name, failure, history, work, action) => {
  expect(nextAction(failure, [...history], limits, work)).toEqual(action);
});
