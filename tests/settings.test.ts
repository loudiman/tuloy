import { expect, test } from 'vitest';
import { openRouterModels } from '../src/models.ts';
import { readSettings } from '../src/settings.ts';

test('settings come from the environment, with defaults for owner, port and data folder', () => {
  expect(readSettings({})).toEqual({ owner: 'Owner', port: 4000, dataDir: './data', peerTasksPerHour: 20, primaryModel: undefined, backupModel: undefined, apiKey: undefined });
  expect(
    readSettings({ TULOY_OWNER: 'Lou', TULOY_PORT: '4100', TULOY_DATA_DIR: '/tmp/lou', TULOY_PEER_TASKS_PER_HOUR: '5', TULOY_PRIMARY_MODEL: 'vendor-a/model-1', TULOY_BACKUP_MODEL: 'vendor-b/model-2', OPENROUTER_API_KEY: 'test-key' }),
  ).toEqual({ owner: 'Lou', port: 4100, dataDir: '/tmp/lou', peerTasksPerHour: 5, primaryModel: 'vendor-a/model-1', backupModel: 'vendor-b/model-2', apiKey: 'test-key' });
});

test('the primary and backup models are the model IDs of the settings', () => {
  const models = openRouterModels(readSettings({ TULOY_PRIMARY_MODEL: 'vendor-a/model-1', TULOY_BACKUP_MODEL: 'vendor-b/model-2', OPENROUTER_API_KEY: 'test-key' }));

  expect([models.primary.modelId, models.backup.modelId]).toEqual(['vendor-a/model-1', 'vendor-b/model-2']);
});

test('a real run needs the key and the two model IDs', () => {
  expect(() => openRouterModels(readSettings({ TULOY_PRIMARY_MODEL: 'a/b', TULOY_BACKUP_MODEL: 'c/d' }))).toThrow('OPENROUTER_API_KEY');
  expect(() => openRouterModels(readSettings({ OPENROUTER_API_KEY: 'test-key' }))).toThrow('TULOY_PRIMARY_MODEL, TULOY_BACKUP_MODEL');
});
