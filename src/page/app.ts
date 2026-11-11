/**
 * The dashboard: one screen for one run. It reads the API, draws, and draws again on each new event of the event log.
 * What is shown where is in the address (`#run=3&task=scripts`), so a refresh or a shared link opens the same view.
 * All text from the API goes in as text, never as HTML.
 */
import { duration, headerOf, manilaTime, shownStatus, timelineOf, type EventView, type RunView, type TaskView } from './view.ts';

type RunList = { owner: string; demo?: boolean; sampleGoal: string; runs: RunView[] };
type RunDetail = { run: RunView; tasks: TaskView[]; events: EventView[] };

const $ = (id: string) => document.getElementById(id)!;

/** Makes one element. `text` children go in as text nodes. */
function h(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.append(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
  return element;
}

/** The mark that goes with each status word, so that colour is never the only signal. Fixed drawings, no data from the API. */
const marks: Record<string, string> = {
  queued: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  'waiting on dependency': '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="2.6 2.6"/>',
  running: '<path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/>',
  stalled: '<path d="M3.5 2.5h3.2v11H3.5zM9.3 2.5h3.2v11H9.3z" fill="currentColor"/>',
  recovering: '<path d="M13 8a5 5 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12.9 1.2v4.4H8.5z" fill="currentColor"/>',
  done: '<path d="M2.5 8.5l3.7 3.7 7.3-8" fill="none" stroke="currentColor" stroke-width="2.6"/>',
  escalated: '<path d="M5 1.5h6l3.5 3.5v6L11 14.5H5L1.5 11V5z" fill="currentColor"/>',
  handoff: '<path d="M1.5 8h10M8 3.5L12.5 8 8 12.5" fill="none" stroke="currentColor" stroke-width="2.4"/>',
  trouble: '<path d="M8 1.5l7 12.5H1z" fill="currentColor"/>',
  plain: '<circle cx="8" cy="8" r="3.2" fill="currentColor"/>',
};
marks.recovery = marks.recovering;

function mark(name: string): HTMLElement {
  const span = h('span', { class: 'glyph', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 16 16" width="1em" height="1em">${marks[name] ?? marks.plain}</svg>`;
  return span;
}

/** The status word with its mark. An unknown word gets the plain mark and still shows as text. */
function status(word: string): HTMLElement {
  return h('span', { class: `status status-${word.replaceAll(' ', '-')}` }, mark(word), word);
}

const sampleTag = () => h('span', { class: 'tag' }, 'Sample');
const peerTag = (peer: string) => h('span', { class: 'tag tag-peer' }, `for ${peer}`);

// ---- state ----

let list: RunList | undefined;
let detail: RunDetail | undefined;
let failed = false;
const openData = new Set<number>();

/** What the address asks for. No run in the address = the newest run. */
function address() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { runId: Number(params.get('run')) || list?.runs[0]?.id, taskId: params.get('task') };
}
const link = (runId: number, taskId?: string) => `#run=${runId}${taskId ? `&task=${encodeURIComponent(taskId)}` : ''}`;

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json() as Promise<T>;
}

let reading = false;
let again = false;
/** Reads the list of runs and the run of the address, then draws. Calls that come during a read make one more read after it. */
async function refresh() {
  if (reading) return void (again = true);
  reading = true;
  try {
    list = await getJson<RunList>('/api/runs');
    const { runId } = address();
    detail = runId ? await getJson<RunDetail>(`/api/runs/${runId}`).catch(() => undefined) : undefined;
    failed = false;
  } catch {
    failed = true;
  }
  reading = false;
  draw();
  if (again) {
    again = false;
    void refresh();
  }
}

// ---- drawing ----

function draw() {
  drawBar();
  drawSlate();
  drawTasks();
  drawTrail();
  drawResult();
  drawRuns();
  drawDemo();
}

function drawBar() {
  if (!list) return;
  $('owner').textContent = `of ${list.owner}`;
  $('sample-goal').textContent = list.sampleGoal;
  $('demo-tag').hidden = !list.demo;
}

function drawSlate() {
  const slate = $('slate');
  slate.className = 'slate';
  if (failed && !list) {
    return slate.replaceChildren(
      h('p', { class: 'slate-note' }, 'Tuloy does not answer.'),
      h('p', { class: 'slate-help' }, 'Make sure that the program still runs. This page tries again by itself.'),
    );
  }
  if (!list) return slate.replaceChildren(h('p', { class: 'slate-note' }, 'Reading the runs…'));
  if (!detail) {
    const missing = list.runs.length > 0;
    return slate.replaceChildren(
      h('p', { class: 'slate-note' }, missing ? 'This Tuloy has no run with that number.' : 'No run yet.'),
      h(
        'p',
        { class: 'slate-help' },
        missing
          ? 'Open a run from the list of past runs.'
          : 'Start the sample goal. The conductor splits it into tasks, checks each handoff, and recovers alone when a task fails.',
      ),
    );
  }
  const { run, tasks } = detail;
  const head = headerOf(run, tasks, Date.now());
  slate.classList.add(`slate-${run.status}`);
  const field = (label: string, ...value: (Node | string)[]) => h('div', { class: 'field' }, h('dt', {}, label), h('dd', {}, ...value));
  slate.replaceChildren(
    h(
      'div',
      { class: 'slate-top' },
      h(
        'div',
        { class: 'slate-goal' },
        h('p', { class: 'label' }, `Goal of run ${run.id} `, run.goal === list.sampleGoal && sampleTag(), ' ', run.forPeer && peerTag(run.forPeer)),
        h('h1', {}, run.goal),
      ),
      h('p', { class: 'slate-state' }, status(run.status)),
    ),
    h(
      'dl',
      { class: 'fields' },
      field('Started', head.started, h('small', {}, ' PHT')),
      field(run.endedAt === null ? 'Time passed' : 'Took', h('span', { id: 'passed' }, head.passed)),
      field('Tasks done', `${head.done} of ${head.total}`),
      h(
        'div',
        { class: `field field-stuck${head.stuck ? ' is-stuck' : ''}` },
        h('dt', {}, run.status === 'escalated' ? 'Stopped at' : 'Stuck now'),
        h(
          'dd',
          {},
          head.stuck ? h('a', { href: link(run.id, head.stuck.id) }, head.stuck.title) : 'No task',
          head.stuck?.stuckReason ? h('span', { class: 'reason' }, head.stuck.stuckReason) : null,
        ),
      ),
    ),
  );
}

/** The task whose event trail shows: the one in the address, or the stuck task, or the running task, or the first. `all` = the whole run. */
function selected(): string | null {
  if (!detail) return null;
  const { taskId } = address();
  if (taskId === 'all') return null;
  const { run, tasks } = detail;
  const pick =
    tasks.find((t) => t.id === taskId) ??
    headerOf(run, tasks, 0).stuck ??
    tasks.find((t) => shownStatus(t, run.status) === 'running') ??
    tasks[0];
  return pick?.id ?? null;
}

function drawTasks() {
  if (!detail) return $('tasks').replaceChildren(h('li', { class: 'empty' }, 'The tasks of a run show here, each with its agent and its status.'));
  const { run, tasks, events } = detail;
  const pick = selected();
  const title = (id: string) => tasks.find((t) => t.id === id)?.title ?? id;
  $('tasks').replaceChildren(
    ...tasks.map((t) => {
      const count = events.filter((e) => e.taskId === t.id).length;
      return h(
        'li',
        {},
        h(
          'a',
          { class: 'task', href: link(run.id, t.id), ...(t.id === pick ? { 'aria-current': 'true' } : {}) },
          h('span', { class: 'task-title' }, t.title),
          status(shownStatus(t, run.status)),
          h(
            'span',
            { class: 'task-facts' },
            `Agent: ${t.agent ? t.agent.replaceAll('_', ' ') : 'none yet'}`,
            t.dependsOn.length ? ` · after ${t.dependsOn.map(title).join(' and ')}` : '',
            ` · ${count} ${count === 1 ? 'event' : 'events'}`,
          ),
          t.stuckReason ? h('span', { class: 'reason' }, t.stuckReason) : null,
        ),
      );
    }),
    h(
      'li',
      {},
      h('a', { class: 'task task-all', href: link(run.id, 'all'), ...(pick === null ? { 'aria-current': 'true' } : {}) }, `The whole run · ${events.length} events`),
    ),
  );
}

/** The content of an event (for example a handoff's checked fields) as lists, not as raw JSON. */
function content(value: unknown): Node {
  if (Array.isArray(value)) return h('ol', { class: 'data-list' }, ...value.map((item) => h('li', {}, content(item))));
  if (value !== null && typeof value === 'object') {
    return h('dl', { class: 'data' }, ...Object.entries(value).flatMap(([key, item]) => [h('dt', {}, key.replaceAll('_', ' ')), h('dd', {}, content(item))]));
  }
  return document.createTextNode(String(value));
}

function drawTrail() {
  const trail = $('trail');
  if (!detail) {
    $('trail-title').textContent = 'Event trail';
    return trail.replaceChildren(h('li', { class: 'empty' }, 'Handoffs, retries, model switches and re-routes show here as they happen.'));
  }
  const pick = selected();
  const task = detail.tasks.find((t) => t.id === pick);
  $('trail-title').textContent = task ? `Event trail · ${task.title}` : 'Event trail · the whole run';
  const taskTitle = (id: string) => detail!.tasks.find((t) => t.id === id)?.title ?? id;
  const rows = timelineOf(detail.events, pick);
  if (rows.length === 0) return trail.replaceChildren(h('li', { class: 'empty' }, 'No event for this task yet. It did not start.'));
  trail.replaceChildren(
    ...rows.map((row) => {
      const details =
        row.data !== null && row.data !== undefined
          ? h('details', openData.has(row.seq) ? { open: '' } : {}, h('summary', {}, row.kind === 'handoff' ? 'What was handed off' : 'Content'), content(row.data))
          : null;
      details?.addEventListener('toggle', () => ((details as HTMLDetailsElement).open ? openData.add(row.seq) : openData.delete(row.seq)));
      return h(
        'li',
        { class: `event event-${row.kind}` },
        h('time', {}, row.time),
        mark(row.kind),
        h('div', { class: 'event-body' }, h('p', { class: 'event-title' }, pick === null && row.taskId ? h('span', { class: 'event-task' }, taskTitle(row.taskId)) : null, row.title, ' ', h('span', { class: 'event-result' }, row.result)), h('p', { class: 'event-cause' }, row.cause), details),
      );
    }),
  );
}

type Script = { id?: string; hook?: string; body?: string; cta?: string; language?: string };
type Post = { script_id?: string; platform?: string; time?: string; reason?: string };
type Review = { script_id?: string; verdict?: string };

function drawResult() {
  const result = $('result');
  result.className = 'result';
  if (!detail) return result.replaceChildren();
  const { run, tasks, events } = detail;
  // When a peer did the full goal, the one task with role `goal` holds the scripts and the schedule.
  const output = (role: string) => (tasks.find((t) => t.role === role) ?? tasks.find((t) => t.role === 'goal'))?.output as Record<string, unknown> | null | undefined;
  const scripts = (output('script')?.scripts ?? []) as Script[];
  const reviews = (output('reviewer')?.reviews ?? []) as Review[];
  const posts = ((output('scheduler')?.posts ?? []) as Post[]).toSorted((a, b) => Date.parse(a.time ?? '') - Date.parse(b.time ?? ''));
  const parts: Node[] = [h('h2', { id: 'result-title' }, 'Result')];

  if (run.status === 'escalated') {
    result.classList.add('result-escalated');
    const stuck = headerOf(run, tasks, 0).stuck;
    const last = timelineOf(events, stuck?.id ?? null).at(-1);
    parts.push(
      h(
        'div',
        { class: 'stop' },
        h('p', { class: 'stop-title' }, mark('escalated'), 'This run stopped as escalated.'),
        h(
          'p',
          {},
          stuck ? `The conductor could not finish the task “${stuck.title}”. ` : 'The conductor could not finish the goal. ',
          posts.length ? '' : 'It made no posting schedule. Nothing here is a finished result.',
        ),
        stuck?.stuckReason ? h('p', { class: 'reason' }, stuck.stuckReason) : null,
        last ? h('p', { class: 'stop-last' }, `Last event, ${last.time} PHT: ${last.title}, ${last.result}. ${last.cause}`) : null,
      ),
    );
  } else if (scripts.length === 0 && posts.length === 0) {
    parts.push(h('p', { class: 'empty' }, 'The scripts and the posting schedule show here when their tasks are done.'));
  }

  if (scripts.length) {
    parts.push(
      h('h3', {}, `Scripts · ${scripts.length}`),
      h(
        'div',
        { class: 'scripts' },
        ...scripts.map((s) => {
          const verdict = reviews.find((r) => r.script_id === s.id)?.verdict;
          return h(
            'article',
            { class: 'script' },
            h('p', { class: 'script-head' }, h('span', { class: 'script-id' }, s.id ?? ''), h('span', { class: 'tag' }, s.language ?? ''), verdict ? h('span', { class: 'tag' }, `Review: ${verdict}`) : null),
            h('p', { class: 'label' }, 'Hook'),
            h('p', { class: 'hook' }, s.hook ?? ''),
            h('p', { class: 'label' }, 'Body'),
            h('p', { class: 'body' }, s.body ?? ''),
            h('p', { class: 'label' }, 'CTA'),
            h('p', { class: 'cta' }, s.cta ?? ''),
          );
        }),
      ),
    );
  }
  if (posts.length) {
    parts.push(
      h('h3', {}, 'Posting schedule · Manila time (PHT)'),
      h(
        'ol',
        { class: 'posts' },
        ...posts.map((p) => {
          const time = Date.parse(p.time ?? '');
          const hook = scripts.find((s) => s.id === p.script_id)?.hook;
          return h(
            'li',
            { class: 'post' },
            h('time', {}, Number.isNaN(time) ? (p.time ?? '') : manilaTime(time).slice(0, -3)),
            h('span', { class: 'platform' }, p.platform ?? ''),
            h('span', { class: 'post-what' }, h('span', { class: 'script-id' }, p.script_id ?? ''), hook ? ` ${hook}` : ''),
            h('span', { class: 'post-why' }, p.reason ?? ''),
          );
        }),
      ),
    );
  }
  result.replaceChildren(...parts);
  // A done run leads with its result; a run that still works leads with its tasks.
  if (run.status === 'done') $('slate').after(result);
  else result.parentElement!.append(result);
}

function drawRuns() {
  if (!list) return;
  if (list.runs.length === 0) return $('runs').replaceChildren(h('li', { class: 'empty' }, 'Each run stays here after it ends, so you can open it later.'));
  const { runId } = address();
  $('runs').replaceChildren(
    ...list.runs.map((run) =>
      h(
        'li',
        {},
        h(
          'a',
          { class: 'run', href: link(run.id), ...(run.id === runId ? { 'aria-current': 'true' } : {}) },
          h('span', { class: 'run-head' }, h('span', { class: 'run-id' }, `Run ${run.id}`), status(run.status)),
          h('span', { class: 'run-goal' }, run.goal),
          h('span', { class: 'run-when' }, `${manilaTime(run.startedAt)} PHT `, run.goal === list!.sampleGoal && sampleTag(), ' ', run.forPeer && peerTag(run.forPeer)),
        ),
      ),
    ),
  );
}

// ---- demo mode: injections ----

const kinds: [kind: string, label: string][] = [
  ['timeout', 'Timeout'],
  ['invalid_output', 'Invalid output'],
  ['reviewer_rejection', 'Reviewer rejection'],
  ['primary_outage', 'Outage of the primary model'],
  ['all_models_outage', 'Outage of all own models'],
  ['peer_silent', 'Silent peer'],
  ['peer_refuses', 'Peer refuses'],
];
// `goal` is the full goal at a peer (step 4): only the two peer injections act on it.
const roles = ['trend_scout', 'script', 'reviewer', 'scheduler', 'goal'];
let pendingWorks = true;

function drawDemo() {
  $('demo').hidden = !list?.demo;
}

/** Shows the injections that wait. A Tuloy with no injection API yet shows none, and the page stops asking. */
async function readPending() {
  if (!list?.demo || !pendingWorks) return;
  const response = await fetch('/api/injections').catch(() => undefined);
  if (!response?.ok) return void (pendingWorks = false);
  const body: unknown = await response.json().catch(() => undefined);
  const pending = Array.isArray(body) ? body : ((body as { injections?: unknown })?.injections ?? []);
  $('demo-pending').replaceChildren(
    ...(Array.isArray(pending) ? pending : []).map((p: { kind?: string; task?: string }) =>
      h('li', {}, `Waiting: ${String(p.kind ?? 'injection').replaceAll('_', ' ')} at ${String(p.task ?? 'a task').replaceAll('_', ' ')}`),
    ),
  );
}

async function inject(kind: string, label: string) {
  const task = ($('demo-task') as HTMLSelectElement).value;
  const note = $('demo-note');
  note.className = 'demo-note';
  const response = await fetch('/api/injections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task, kind }) }).catch(() => undefined);
  if (response?.ok) {
    note.textContent = `Injected: ${label.toLowerCase()} at the ${task.replaceAll('_', ' ')} agent. It applies to the next start of that agent.`;
    pendingWorks = true;
    return void readPending();
  }
  note.classList.add('is-refused');
  note.textContent = `Not injected. This Tuloy does not have “${label.toLowerCase()}” yet${response ? ` (answer ${response.status})` : ' (no answer)'}.`;
}

function setUpDemo() {
  $('demo-task').replaceChildren(...roles.map((role) => h('option', { value: role, ...(role === 'script' ? { selected: '' } : {}) }, role.replaceAll('_', ' '))));
  $('demo-kinds').replaceChildren(
    ...kinds.map(([kind, label]) => {
      const button = h('button', { type: 'button' }, label);
      button.addEventListener('click', () => void inject(kind, label));
      return button;
    }),
  );
}

// ---- start ----

/** Starts a run and opens it. No goal = the labelled sample goal. A refused goal shows the server's reason. */
async function start(goal?: string): Promise<boolean> {
  const note = $('start-note');
  note.textContent = '';
  const response = await fetch('/api/runs', { method: 'POST', body: goal === undefined ? undefined : JSON.stringify({ goal }) }).catch(() => undefined);
  if (!response?.ok) {
    const answer = (await response?.json().catch(() => undefined)) as { error?: string } | undefined;
    note.textContent = response ? `The run did not start: ${answer?.error ?? `answer ${response.status}`}.` : 'The run did not start: Tuloy does not answer.';
    return false;
  }
  const { runId } = (await response.json()) as { runId: number };
  location.hash = link(runId);
  return true;
}
$('start').addEventListener('click', () => void start());
$('goal-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('goal-input') as HTMLInputElement;
  if (input.value.trim() && (await start(input.value.trim()))) input.value = '';
});
addEventListener('hashchange', () => void refresh());
// The time passed of a running run moves each second. All other numbers change only with an event.
setInterval(() => {
  const passed = document.getElementById('passed');
  if (passed && detail && detail.run.endedAt === null) passed.textContent = duration(Date.now() - detail.run.startedAt);
}, 1000);

setUpDemo();
// Live updates: each new event of the event log reads the state again. No reload. The browser connects again by itself after a break.
const live = new EventSource('/api/events');
live.onmessage = () => void refresh().then(readPending);
live.onerror = () => void refresh();
void refresh().then(readPending);
