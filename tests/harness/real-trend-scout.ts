/**
 * The trend scout alone, with the real models and the web search. It costs credits: one or two model calls and the searches.
 * It prints where the trends came from, the pages, and why there was no search. It prints no key.
 *
 *   TULOY_TREND_SEARCH=1 node --env-file-if-exists=.env tests/harness/real-trend-scout.ts [primary|backup]
 */
import { runAgent } from '../../src/agent-runner.ts';
import { systemClock } from '../../src/clock.ts';
import { openRouterModels } from '../../src/models.ts';
import { readSettings } from '../../src/settings.ts';

const settings = readSettings(process.env);
const models = openRouterModels(settings);
const which = process.argv[2] === 'backup' ? 'backup' : 'primary';
const started = Date.now();
const result = await runAgent('trend_scout', { goal: 'Make short-video scripts and a posting schedule for a sari-sari store in Quezon City this week.' }, models[which], {
  clock: systemClock,
  limits: settings.limits,
  search: models.search,
});
console.log(`${which} model, ${Math.round((Date.now() - started) / 1000)} s`);
if (!result.ok) console.log('failed:', result.failure.kind, result.failure.detail);
else {
  const output = result.output as { trends: { topic: string }[]; search?: string; search_note?: string; sources?: { title: string; url: string }[] };
  console.log('search:', output.search, '|', output.search_note ?? '');
  for (const source of output.sources ?? []) console.log(' -', source.title, '|', source.url);
  for (const trend of output.trends) console.log(' *', trend.topic);
}
