import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { expect, test } from 'vitest';
import { runAgent } from '../src/agent-runner.ts';
import { systemClock } from '../src/clock.ts';
import { defaultLimits } from '../src/settings.ts';
import { goodOutput } from './harness/scripted-model.ts';

// The search tool of OpenRouter. Making it sends nothing; the model here is a fake.
const search = createOpenRouter({ apiKey: 'not-a-key' }).tools.webSearch({ maxResults: 5 });
const options = { clock: systemClock, limits: defaultLimits };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

/** A fake model: `answer` gets the call and returns the content, or throws. */
function fake(answer: (call: LanguageModelV4CallOptions) => unknown[]) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (call: LanguageModelV4CallOptions) => {
      calls.push(call);
      return { content: answer(call) as never, finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] };
    },
  });
  return { model, calls };
}
const text = (output: unknown) => ({ type: 'text', text: JSON.stringify(output) });
const page = (url: string, title: string) => ({ type: 'source', sourceType: 'url', id: url, url, title });

test('the trend scout with search gets the search tool, and its output names the pages that the search gave', async () => {
  const { model, calls } = fake(() => [page('https://example.com/a', 'Page A'), page('https://example.com/a', 'Page A'), page('javascript:alert(1)', 'Bad'), text(goodOutput.trend_scout)]);
  const result = await runAgent('trend_scout', { goal: 'g' }, model, { ...options, search });
  expect(result).toMatchObject({ ok: true, output: { search: 'web', sources: [{ title: 'Page A', url: 'https://example.com/a' }] } });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.tools).toHaveLength(1);
  expect(String(calls[0]!.prompt.find((m) => m.role === 'system')!.content)).toMatch(/web search/);
});

test('when the call with search fails, the trend scout answers with no search and says so', async () => {
  const { model, calls } = fake((call) => {
    if (call.tools?.length) throw new Error('the search is down');
    return [text(goodOutput.trend_scout)];
  });
  const result = await runAgent('trend_scout', { goal: 'g' }, model, { ...options, search });
  expect(result).toMatchObject({ ok: true, output: { search: 'none', sources: [], search_note: 'The call with the search failed: the search is down' } });
  expect(calls).toHaveLength(2);
});

test('a model that searched nothing gives "no search"; sources that a model wrote itself are dropped', async () => {
  const invented = { ...(goodOutput.trend_scout as object), search: 'web', sources: [{ title: 'Invented', url: 'https://example.com/invented' }] };
  const withTool = await runAgent('trend_scout', { goal: 'g' }, fake(() => [text(invented)]).model, { ...options, search });
  expect(withTool).toMatchObject({ ok: true, output: { search: 'none', sources: [], search_note: 'The model did not search.' } });
  const noTool = fake(() => [text(invented)]);
  const plain = await runAgent('trend_scout', { goal: 'g' }, noTool.model, options);
  expect(plain.ok && plain.output).toEqual(goodOutput.trend_scout);
  expect(noTool.calls[0]!.tools ?? []).toHaveLength(0);
});

test('only the trend scout gets the search tool', async () => {
  const { model, calls } = fake(() => [text(goodOutput.script)]);
  await runAgent('script', { goal: 'g', trends: (goodOutput.trend_scout as { trends: unknown }).trends }, model, { ...options, search });
  expect(calls[0]!.tools ?? []).toHaveLength(0);
});
