/** All settings come from the environment. The key is read from the environment only. */
export function readSettings(env: Record<string, string | undefined>) {
  return {
    owner: env.TULOY_OWNER || 'Owner',
    port: Number(env.TULOY_PORT || 4000),
    dataDir: env.TULOY_DATA_DIR || './data',
    primaryModel: env.TULOY_PRIMARY_MODEL || undefined,
    backupModel: env.TULOY_BACKUP_MODEL || undefined,
    apiKey: env.OPENROUTER_API_KEY || undefined,
    limits: {
      /** Retries after the first attempt. */
      retries: Number(env.TULOY_RETRIES || 2),
      /** The wait before the first retry. Each next wait is two times longer. */
      retryWaitMs: Number(env.TULOY_RETRY_WAIT_MS || 2000),
    },
  };
}

export type Settings = ReturnType<typeof readSettings>;
export type Limits = Settings['limits'];
export const defaultLimits: Limits = readSettings({}).limits;
