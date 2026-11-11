import { expect, test } from 'vitest';
import { systemClock } from '../src/clock.ts';

test('the real clock waits, and a wait ends at once when it is stopped', async () => {
  const start = Date.now();
  await systemClock.sleep(20);
  expect(Date.now() - start).toBeGreaterThanOrEqual(15);

  const stop = new AbortController();
  const long = systemClock.sleep(60_000, stop.signal);
  stop.abort();
  await long;
  await systemClock.sleep(60_000, stop.signal); // already stopped
  expect(Date.now() - start).toBeLessThan(5000);
});
