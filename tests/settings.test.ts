import { expect, test } from 'vitest';
import { openRouterModels } from '../src/models.ts';
import { readSettings } from '../src/settings.ts';

test('settings come from the environment, with defaults for owner, port and data folder', () => {
  expect(readSettings({})).toEqual({ owner: 'Owner', port: 4000, dataDir: './data', primaryModel: undefined, backupModel: undefined, apiKey: undefined, limits: { retries: 2, retryWaitMs: 2000 } });
  expect(
    readSettings({ TULOY_OWNER: 'Lou', TULOY_PORT: '4100', TULOY_DATA_DIR: '/tmp/lou', TULOY_PRIMARY_MODEL: 'vendor-a/model-1', TULOY_BACKUP_MODEL: 'vendor-b/model-2', OPENROUTER_API_KEY: 'test-key', TULOY_RETRIES: '1', TULOY_RETRY_WAIT_MS: '500' }),
  ).toEqual({ owner: 'Lou', port: 4100, dataDir: '/tmp/lou', primaryModel: 'vendor-a/model-1', backupModel: 'vendor-b/model-2', apiKey: 'test-key', limits: { retries: 1, retryWaitMs: 500 } });
});

test('the primary and backup models are the model IDs of the settings', () => {
  const models = openRouterModels(readSettings({ TULOY_PRIMARY_MODEL: 'vendor-a/model-1', TULOY_BACKUP_MODEL: 'vendor-b/model-2', OPENROUTER_API_KEY: 'test-key' }));

  expect([models.primary.modelId, models.backup.modelId]).toEqual(['vendor-a/model-1', 'vendor-b/model-2']);
});

test('a real run needs the key and the two model IDs', () => {
  expect(() => openRouterModels(readSettings({ TULOY_PRIMARY_MODEL: 'a/b', TULOY_BACKUP_MODEL: 'c/d' }))).toThrow('OPENROUTER_API_KEY');
  expect(() => openRouterModels(readSettings({ OPENROUTER_API_KEY: 'test-key' }))).toThrow('TULOY_PRIMARY_MODEL, TULOY_BACKUP_MODEL');
});
