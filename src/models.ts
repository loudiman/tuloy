import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { Settings } from './settings.ts';

/** The real models: OpenRouter through the Vercel AI SDK. This makes no call; a call happens when an agent runs. */
export function openRouterModels({ apiKey, primaryModel, backupModel, trendSearch }: Settings) {
  const missing = [!apiKey && 'OPENROUTER_API_KEY', !primaryModel && 'TULOY_PRIMARY_MODEL', !backupModel && 'TULOY_BACKUP_MODEL'].filter(Boolean);
  if (!apiKey || !primaryModel || !backupModel) throw new Error(`A real run needs these settings: ${missing.join(', ')}. See .env.example.`);
  const openrouter = createOpenRouter({ apiKey });
  // The web search of OpenRouter, for the trend scout. It uses the same key.
  // Hard limits, as the OpenRouter documents give them: 3 searches for one call, 5 results for each search, 15 results in all.
  // The package has no type for `parameters`, but it sends each argument as it is.
  const limits = { maxResults: 5, parameters: { max_results: 5, max_uses: 3, max_total_results: 15 } } as { maxResults: number };
  return { primary: openrouter(primaryModel), backup: openrouter(backupModel), search: trendSearch ? openrouter.tools.webSearch(limits) : undefined };
}
