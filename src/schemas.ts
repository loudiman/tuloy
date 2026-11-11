import { z } from 'zod';

/** One input schema and one output schema per agent role. Extra fields are dropped; required fields must validate. */

const trend = z.object({ topic: z.string().min(1), why: z.string().min(1) });

const script = z.object({
  id: z.string().min(1),
  hook: z.string().min(1),
  body: z.string().min(1),
  cta: z.string().min(1),
  language: z.enum(['english', 'filipino', 'taglish']),
});

const review = z.object({
  script_id: z.string().min(1),
  verdict: z.enum(['pass', 'reject']),
  issues: z.array(z.string()),
});

const post = z.object({
  script_id: z.string().min(1),
  platform: z.string().min(1),
  /** A time with its offset, for example 2026-11-13T19:00:00+08:00. */
  time: z.iso.datetime({ offset: true }),
  reason: z.string().min(1),
});

const goal = z.string().min(1);
const trends = z.array(trend).min(1);
const scripts = z.array(script).min(1);
const reviews = z.array(review).min(1);

export const roles = {
  trend_scout: { input: z.object({ goal }), output: z.object({ trends }) },
  script: { input: z.object({ goal, trends }), output: z.object({ scripts }) },
  reviewer: { input: z.object({ goal, scripts }), output: z.object({ reviews }) },
  scheduler: {
    input: z.object({ goal, scripts, reviews }),
    output: z.object({ timezone: z.literal('Asia/Manila'), posts: z.array(post).min(1) }),
  },
} satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

export type Role = keyof typeof roles;
