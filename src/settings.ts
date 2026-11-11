/** All settings come from the environment. The key is read from the environment only. */
export function readSettings(env: Record<string, string | undefined>) {
  return {
    owner: env.TULOY_OWNER || 'Owner',
    port: Number(env.TULOY_PORT || 4000),
    dataDir: env.TULOY_DATA_DIR || './data',
    peerTasksPerHour: Number(env.TULOY_PEER_TASKS_PER_HOUR || 20),
    primaryModel: env.TULOY_PRIMARY_MODEL || undefined,
    backupModel: env.TULOY_BACKUP_MODEL || undefined,
    apiKey: env.OPENROUTER_API_KEY || undefined,
    /** Demo mode. Injection exists only in demo mode. */
    demo: env.TULOY_DEMO === '1',
    limits: {
      /** Retries after the first attempt. */
      retries: Number(env.TULOY_RETRIES || 2),
      /** The wait before the first retry. Each next wait is two times longer. */
      retryWaitMs: Number(env.TULOY_RETRY_WAIT_MS || 2000),
      /** The time limit of one attempt of a task. */
      taskTimeLimitMs: Number(env.TULOY_TASK_TIME_LIMIT_MS || 60_000),
      /** A running agent sends a heartbeat this often. */
      heartbeatMs: Number(env.TULOY_HEARTBEAT_MS || 5000),
      /** With no heartbeat for this long, the agent is stalled. */
      heartbeatMissedMs: Number(env.TULOY_HEARTBEAT_MISSED_MS || 20_000),
      /** At most this number of model calls run at the same time, over all runs. */
      maxModelCalls: Number(env.TULOY_MAX_MODEL_CALLS || 2),
      /** The limit on output tokens of each model call. */
      maxOutputTokens: Number(env.TULOY_MAX_OUTPUT_TOKENS || 2000),
    },
  };
}

export type Settings = ReturnType<typeof readSettings>;
export type Limits = Settings['limits'];
export const defaultLimits: Limits = readSettings({}).limits;
