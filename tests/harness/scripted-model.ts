import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import type { Role } from '../../src/schemas.ts';

/** One scripted answer: a value (or a promise of one) is returned as the model's JSON; an Error is thrown as the model's failure. */
export type Step = unknown;

/**
 * The scripted model never calls a real model. It reads the agent role from the first line of the
 * system prompt ("ROLE: script") and answers with a good fixed output for that role.
 * `script` overrides that: for each role, a list of steps used one per call, in order.
 * When a role's list is used up, the good output comes back again.
 *
 *   scriptedModel({ script: [{ scripts: 'junk' }] })           // first script call returns a bad output
 *   scriptedModel({ script: [new Error('model down')] })       // first script call fails
 */
export function scriptedModel(script: Partial<Record<Role, Step[]>> = {}) {
  const calls: { role: Role; prompt: string }[] = [];
  const left: Partial<Record<Role, Step[]>> = Object.fromEntries(Object.entries(script).map(([role, steps]) => [role, [...steps]]));
  const model = new MockLanguageModelV4({
    provider: 'scripted',
    modelId: 'scripted',
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      const system = options.prompt.find((m) => m.role === 'system');
      const role = /^ROLE: (\w+)/.exec(system ? String(system.content) : '')?.[1] as Role;
      const prompt = options.prompt
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content)
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n');
      calls.push({ role, prompt });
      const steps = left[role];
      // A step may be a promise: the model then answers when the test resolves it.
      const step = await (steps?.length ? steps.shift() : goodOutput[role]);
      if (step instanceof Error) throw step;
      return {
        content: [{ type: 'text', text: JSON.stringify(step) }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 50, text: 50, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return Object.assign(model, { calls });
}

/** A good output for each role. Tests may compare final state with these. */
export const goodOutput: Record<Role, unknown> = {
  trend_scout: {
    trends: [
      { topic: 'Sari-sari store hacks', why: 'Small-shop owners share stock tricks this week.' },
      { topic: 'Payday budget meals', why: 'Searches rise before the 15th.' },
    ],
  },
  script: {
    scripts: [
      { id: 's1', hook: 'Tatlong sari-sari hacks na di mo pa alam!', body: 'Una, ayusin ang paninda by price. Then, track your utang list sa phone.', cta: 'I-follow para sa part 2!', language: 'taglish' },
      { id: 's2', hook: 'Payday meals under 100 pesos', body: 'Three meals, one small budget, all from the palengke.', cta: 'Save this for payday.', language: 'english' },
    ],
  },
  reviewer: {
    reviews: [
      { script_id: 's1', verdict: 'pass', issues: [] },
      { script_id: 's2', verdict: 'pass', issues: [] },
    ],
  },
  scheduler: {
    timezone: 'Asia/Manila',
    posts: [
      { script_id: 's1', platform: 'tiktok', time: '2026-11-13T19:00:00+08:00', reason: 'Evening scroll time after work.' },
      { script_id: 's2', platform: 'reels', time: '2026-11-14T12:00:00+08:00', reason: 'Lunch break the day before payday.' },
    ],
  },
};
