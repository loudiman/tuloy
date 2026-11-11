/** All settings come from the environment. The key is read from the environment only. */
export function readSettings(env: Record<string, string | undefined>) {
  return {
    owner: env.TULOY_OWNER || 'Owner',
    port: Number(env.TULOY_PORT || 4000),
    dataDir: env.TULOY_DATA_DIR || './data',
    primaryModel: env.TULOY_PRIMARY_MODEL || undefined,
    backupModel: env.TULOY_BACKUP_MODEL || undefined,
    apiKey: env.OPENROUTER_API_KEY || undefined,
  };
}

export type Settings = ReturnType<typeof readSettings>;
