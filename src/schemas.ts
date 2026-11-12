import { z } from 'zod';

/** One input schema and one output schema per agent role. Extra fields are dropped; required fields must validate. */

const trend = z.object({ topic: z.string().min(1), why: z.string().min(1) });
/** A page that the web search of the trend scout gave. Tuloy writes these fields, not the model. */
const source = z.object({ title: z.string().max(300), url: z.string().max(2000).regex(/^https?:\/\//) });

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
  /** 0 is the worst, 10 is the best. */
  score: z.number().min(0).max(10),
  issues: z.array(z.string()),
  /** For a rejected script: how to fix the issues. */
  hints: z.array(z.string()),
});

/** What the script agent gets when the reviewer rejected its scripts: the issues and hints of each rejected script. */
const reviewerHints = z.array(review.pick({ script_id: true, issues: true, hints: true }));

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
  trend_scout: { input: z.object({ goal }), output: z.object({ trends, search: z.enum(['web', 'none']).optional(), sources: z.array(source).max(15).optional(), search_note: z.string().max(300).optional() }) },
  script: { input: z.object({ goal, trends, reviewer_hints: reviewerHints.optional() }), output: z.object({ scripts }) },
  reviewer: { input: z.object({ goal, scripts }), output: z.object({ reviews }) },
  scheduler: {
    input: z.object({ goal, scripts, reviews }),
    output: z.object({ timezone: z.literal('Asia/Manila'), posts: z.array(post).min(1) }),
  },
} satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

export type Role = keyof typeof roles;

/**
 * What a peer can ask for: one task for one agent role, or the full goal. `goal` is not an agent role: the peer's conductor
 * does a full run and returns the scripts and the posting schedule, checked against the script and schedule schemas.
 */
export const skills = { ...roles, goal: { input: z.object({ goal }), output: roles.script.output.extend(roles.scheduler.output.shape) } };

export type Skill = keyof typeof skills;
