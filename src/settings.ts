/**
 * All settings come from the environment. The key is read from the environment only.
 * It throws when a numeric setting is not a whole number in its range: a value such as "abc" must stop the start, not become NaN.
 */
export function readSettings(env: Record<string, string | undefined>) {
  const whole = (name: string, fallback: number, min: number, max: number) => {
    const text = env[name];
    if (!text) return fallback;
    const value = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!(value >= min && value <= max)) throw new Error(`${name} must be a whole number from ${min} to ${max}, and it is "${text}".`);
    return value;
  };
  return {
    owner: env.TULOY_OWNER || 'Owner',
    /** The address that the server listens on. The default takes calls from this machine only. */
    host: env.TULOY_HOST || '127.0.0.1',
    port: whole('TULOY_PORT', 4000, 1, 65_535),
    dataDir: env.TULOY_DATA_DIR || './data',
    peerTasksPerHour: whole('TULOY_PEER_TASKS_PER_HOUR', 20, 0, 10_000),
    primaryModel: env.TULOY_PRIMARY_MODEL || undefined,
    backupModel: env.TULOY_BACKUP_MODEL || undefined,
    apiKey: env.OPENROUTER_API_KEY || undefined,
    /** Permits plain-http addresses of peers on this same machine (two Tuloys on one laptop). Off by default; no effect in production. */
    peerAllowLocal: env.TULOY_PEER_ALLOW_LOCAL === '1' && env.NODE_ENV !== 'production',
    /** Demo mode. Injection exists only in demo mode. */
    demo: env.TULOY_DEMO === '1',
    limits: {
      /** Retries after the first attempt. */
      retries: whole('TULOY_RETRIES', 2, 0, 10),
      /** The wait before the first retry. Each next wait is two times longer. */
      retryWaitMs: whole('TULOY_RETRY_WAIT_MS', 2000, 0, 600_000),
      /** The time limit of one attempt of a task. */
      taskTimeLimitMs: whole('TULOY_TASK_TIME_LIMIT_MS', 60_000, 100, 3_600_000),
      /** A running agent sends a heartbeat this often. */
      heartbeatMs: whole('TULOY_HEARTBEAT_MS', 5000, 10, 600_000),
      /** With no heartbeat for this long, the agent is stalled. */
      heartbeatMissedMs: whole('TULOY_HEARTBEAT_MISSED_MS', 20_000, 10, 3_600_000),
      /** At most this number of model calls run at the same time, over all runs. */
      maxModelCalls: whole('TULOY_MAX_MODEL_CALLS', 2, 1, 20),
      /** The limit on output tokens of each model call. */
      maxOutputTokens: whole('TULOY_MAX_OUTPUT_TOKENS', 4000, 1, 100_000),
    },
  };
}

export type Settings = ReturnType<typeof readSettings>;
export type Limits = Settings['limits'];
export const defaultLimits: Limits = readSettings({}).limits;
