import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { Settings } from './settings.ts';

/** The real models: OpenRouter through the Vercel AI SDK. This makes no call; a call happens when an agent runs. */
export function openRouterModels({ apiKey, primaryModel, backupModel, trendSearch }: Settings) {
  const missing = [!apiKey && 'OPENROUTER_API_KEY', !primaryModel && 'TULOY_PRIMARY_MODEL', !backupModel && 'TULOY_BACKUP_MODEL'].filter(Boolean);
  if (!apiKey || !primaryModel || !backupModel) throw new Error(`A real run needs these settings: ${missing.join(', ')}. See .env.example.`);
  const openrouter = createOpenRouter({ apiKey });
  // The web search of OpenRouter, for the trend scout. It uses the same key. 5 results at most for each search.
  return { primary: openrouter(primaryModel), backup: openrouter(backupModel), search: trendSearch ? openrouter.tools.webSearch({ maxResults: 5 }) : undefined };
}
