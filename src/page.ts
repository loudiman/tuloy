/** The plain live page. Ticket #7 replaces it with the real dashboard. All text goes in with textContent, never as HTML. */
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tuloy</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .3rem .6rem; border-bottom: 1px solid #ccc; vertical-align: top; }
  .sample { border: 1px solid; padding: 0 .4rem; font-size: .8rem; text-transform: uppercase; }
  pre { white-space: pre-wrap; margin: 0; font-size: .8rem; }
</style>
</head>
<body>
<h1>Tuloy <small id="owner"></small></h1>
<p><span class="sample">Sample goal</span> <span id="sample-goal"></span></p>
<p><button id="start">Start the sample goal</button></p>
<div id="run" hidden>
  <h2>Run <span id="run-id"></span>: <span id="run-status"></span></h2>
  <p>Goal: <span id="goal"></span> <span id="goal-sample" class="sample" hidden>Sample</span></p>
  <p>Started <span id="started"></span> (Manila time)</p>
  <h2>Tasks</h2>
  <table><thead><tr><th>Task</th><th>Agent</th><th>Status</th></tr></thead><tbody id="tasks"></tbody></table>
  <h2>Scripts</h2>
  <table><thead><tr><th>Id</th><th>Language</th><th>Hook</th><th>Body</th><th>CTA</th></tr></thead><tbody id="scripts"></tbody></table>
  <h2>Posting schedule <small id="timezone"></small></h2>
  <table><thead><tr><th>Script</th><th>Platform</th><th>Time</th><th>Reason</th></tr></thead><tbody id="posts"></tbody></table>
  <h2>Events</h2>
  <table><thead><tr><th>Time</th><th>Task</th><th>Action</th><th>Result</th><th>Cause</th><th>Content</th></tr></thead><tbody id="events"></tbody></table>
</div>
<p id="empty">No run yet.</p>
<script>
const $ = (id) => document.getElementById(id);
const manila = (ms) => new Date(ms).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
const words = (status) => status.replaceAll('_', ' ');
function rows(id, list, cells) {
  $(id).replaceChildren(...list.map((item) => {
    const tr = document.createElement('tr');
    for (const text of cells(item)) tr.insertCell().textContent = text ?? '';
    return tr;
  }));
}
let sampleGoal = '';
async function show(runId) {
  const { run, tasks, events } = await (await fetch('/api/runs/' + runId)).json();
  $('run').hidden = false; $('empty').hidden = true;
  $('run-id').textContent = run.id; $('run-status').textContent = run.status;
  $('goal').textContent = run.goal; $('goal-sample').hidden = run.goal !== sampleGoal;
  $('started').textContent = manila(run.startedAt);
  rows('tasks', tasks, (t) => [t.title, t.agent ?? 'none yet', words(t.status)]);
  const output = (role) => tasks.find((t) => t.role === role)?.output;
  rows('scripts', output('script')?.scripts ?? [], (s) => [s.id, s.language, s.hook, s.body, s.cta]);
  rows('posts', output('scheduler')?.posts ?? [], (p) => [p.script_id, p.platform, p.time, p.reason]);
  $('timezone').textContent = output('scheduler')?.timezone ?? '';
  rows('events', events, (e) => [manila(e.time), e.taskId ?? 'run', e.action, e.result, e.cause, e.data ? JSON.stringify(e.data) : '']);
  for (const tr of $('events').rows) { const pre = document.createElement('pre'); pre.textContent = tr.cells[5].textContent; tr.cells[5].replaceChildren(pre); }
}
async function load() {
  const list = await (await fetch('/api/runs')).json();
  sampleGoal = list.sampleGoal;
  $('owner').textContent = 'of ' + list.owner; $('sample-goal').textContent = sampleGoal;
  if (list.runs[0]) await show(list.runs[0].id);
}
$('start').onclick = () => fetch('/api/runs', { method: 'POST' });
// Live updates: each new event of the event log shows the run again. No reload.
new EventSource('/api/events').onmessage = (message) => show(JSON.parse(message.data).runId);
load();
</script>
</body>
</html>
`;
