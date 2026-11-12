import { expect, test } from 'vitest';
import { openRouterModels } from '../src/models.ts';
import { readSettings } from '../src/settings.ts';

test('settings come from the environment, with defaults for owner, port and data folder', () => {
  expect(readSettings({})).toEqual({ owner: 'Owner', host: '127.0.0.1', port: 4000, dataDir: './data', peerTasksPerHour: 20, peerAllowLocal: false, primaryModel: undefined, backupModel: undefined, apiKey: undefined, trendSearch: false, demo: false, limits: { retries: 2, retryWaitMs: 2000, taskTimeLimitMs: 60_000, heartbeatMs: 5000, heartbeatMissedMs: 20_000, maxModelCalls: 2, maxOutputTokens: 4000 } });
  expect(
    readSettings({ TULOY_OWNER: 'Lou', TULOY_HOST: '0.0.0.0', TULOY_PORT: '4100', TULOY_DATA_DIR: '/tmp/lou', TULOY_PEER_TASKS_PER_HOUR: '5', TULOY_PRIMARY_MODEL: 'vendor-a/model-1', TULOY_BACKUP_MODEL: 'vendor-b/model-2', OPENROUTER_API_KEY: 'test-key', TULOY_RETRIES: '1', TULOY_RETRY_WAIT_MS: '500', TULOY_TASK_TIME_LIMIT_MS: '9000', TULOY_HEARTBEAT_MS: '1000', TULOY_HEARTBEAT_MISSED_MS: '3000', TULOY_MAX_MODEL_CALLS: '4', TULOY_MAX_OUTPUT_TOKENS: '800' }),
  ).toEqual({ owner: 'Lou', host: '0.0.0.0', port: 4100, dataDir: '/tmp/lou', peerTasksPerHour: 5, peerAllowLocal: false, primaryModel: 'vendor-a/model-1', backupModel: 'vendor-b/model-2', apiKey: 'test-key', trendSearch: false, demo: false, limits: { retries: 1, retryWaitMs: 500, taskTimeLimitMs: 9000, heartbeatMs: 1000, heartbeatMissedMs: 3000, maxModelCalls: 4, maxOutputTokens: 800 } });
});

test('the primary and backup models are the model IDs of the settings', () => {
  const models = openRouterModels(readSettings({ TULOY_PRIMARY_MODEL: 'vendor-a/model-1', TULOY_BACKUP_MODEL: 'vendor-b/model-2', OPENROUTER_API_KEY: 'test-key' }));

  expect([models.primary.modelId, models.backup.modelId]).toEqual(['vendor-a/model-1', 'vendor-b/model-2']);
});

test('a real run needs the key and the two model IDs', () => {
  expect(() => openRouterModels(readSettings({ TULOY_PRIMARY_MODEL: 'a/b', TULOY_BACKUP_MODEL: 'c/d' }))).toThrow('OPENROUTER_API_KEY');
  expect(() => openRouterModels(readSettings({ OPENROUTER_API_KEY: 'test-key' }))).toThrow('TULOY_PRIMARY_MODEL, TULOY_BACKUP_MODEL');
});

// ---- Review fix 4: every numeric setting is checked at start-up ----

test.each([
  ['TULOY_RETRIES', 'abc'],
  ['TULOY_RETRIES', '-1'],
  ['TULOY_RETRIES', '1.5'],
  ['TULOY_RETRIES', '1000'],
  ['TULOY_RETRY_WAIT_MS', 'soon'],
  ['TULOY_TASK_TIME_LIMIT_MS', '0'],
  ['TULOY_HEARTBEAT_MS', '0'],
  ['TULOY_HEARTBEAT_MISSED_MS', 'NaN'],
  ['TULOY_MAX_MODEL_CALLS', '0'],
  ['TULOY_MAX_OUTPUT_TOKENS', 'Infinity'],
  ['TULOY_PEER_TASKS_PER_HOUR', '-5'],
  ['TULOY_PORT', '70000'],
  ['TULOY_PORT', '4000x'],
])('a bad value stops the start with a message that names the setting: %s=%s', (name, value) => {
  expect(() => readSettings({ [name]: value })).toThrow(new RegExp(`^${name} must be a whole number from \\d+ to \\d+, and it is "${value}"\\.$`));
});

test('the limits of each numeric setting are permitted values', () => {
  expect(readSettings({ TULOY_RETRIES: '0', TULOY_PEER_TASKS_PER_HOUR: '0', TULOY_PORT: '65535', TULOY_RETRY_WAIT_MS: '0' })).toMatchObject({ port: 65535, peerTasksPerHour: 0, limits: { retries: 0, retryWaitMs: 0 } });
});
