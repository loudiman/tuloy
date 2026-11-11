/** The peers screen, at /peers. All text goes in with textContent, never as HTML. The API gives it no full key. */
export const peersPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tuloy: peers</title>
<link rel="preload" href="/fonts/archivo.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/martian-mono.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/page/style.css">
</head>
<body>
<header class="bar">
  <p class="mark">Tuloy <span id="owner" class="owner"></span></p>
  <nav class="nav" aria-label="Screens"><a href="/">Runs</a><a href="/peers" aria-current="page">Peers</a></nav>
</header>

<main>
  <section class="slate slate-plain">
    <p class="label">Allowed list</p>
    <h1>Peers</h1>
    <p class="slate-help">The peers and outside agents that can give work to this Tuloy and take work from it. Nothing outside this list gets work or gives work.</p>
  </section>

  <section class="sheet table-wrap" aria-label="The allowed list">
    <table class="peer-table">
      <thead><tr><th>Name</th><th>Address</th><th>Lends</th><th>Tasks in the last hour</th><th>Keys</th><th></th></tr></thead>
      <tbody id="peers"></tbody>
    </table>
    <p id="loading" class="peers-note">Reading the allowed list&hellip;</p>
    <p id="empty" class="peers-note" hidden>Nobody is on the allowed list. Make an invite and send it to another owner, or paste an invite that you got.</p>
  </section>
  <p id="message" role="status"></p>

  <div class="peer-forms">
    <section class="sheet">
      <h2>Invite another owner</h2>
      <p><button id="make" type="button">Make an invite link</button></p>
      <div id="made" hidden>
        <input id="link" readonly aria-label="Invite link">
        <p><span class="note">It works one time and stops working after 24 hours. Send it only to the owner that you invite.</span></p>
        <p><button id="copy" type="button">Copy the link</button></p>
      </div>
    </section>

    <section class="sheet">
      <h2>Accept an invite</h2>
      <form id="accept">
        <label>Invite link from another owner <input id="paste" required autocomplete="off"></label>
        <button>Accept the invite</button>
      </form>
    </section>

    <section class="sheet">
      <h2>Add an A2A agent</h2>
      <form id="add">
        <label>Name <input id="name" required maxlength="100" autocomplete="off"></label>
        <label>Address <input id="address" type="url" required placeholder="https://agent.example" autocomplete="off"></label>
        <label>Key to send with <input id="key" type="password" required autocomplete="off"></label>
        <button>Add to the allowed list</button>
      </form>
    </section>
  </div>
</main>

<script>
const $ = (id) => document.getElementById(id);
const say = (text) => { $('message').textContent = text; };
/** Calls the API and gives the body; an error answer becomes the message on the screen. */
async function call(method, path, body) {
  const answer = await fetch(path, { method, body: body && JSON.stringify(body) });
  const data = answer.status === 204 ? {} : await answer.json().catch(() => ({}));
  if (!answer.ok) { say(data.error ?? 'That did not work.'); return null; }
  return data;
}
const keyEnd = (end) => end ? '\\u2026' + end : 'hidden';
async function load() {
  const list = await call('GET', '/api/peers');
  $('loading').hidden = true;
  if (!list) return;
  $('owner').textContent = 'of ' + list.owner;
  $('empty').hidden = list.peers.length > 0;
  $('peers').replaceChildren(...list.peers.map((peer) => {
    const tr = document.createElement('tr');
    const lends = peer.lends === null ? 'The agent card cannot be read now' : peer.lends.length ? peer.lends.join(', ') : 'Nothing';
    for (const text of [peer.name, peer.address, lends, peer.tasksInLastHour + ' of ' + list.tasksPerHourLimit + ' permitted']) tr.insertCell().textContent = text;
    const keys = tr.insertCell(); keys.className = 'key';
    keys.textContent = 'sends ' + keyEnd(peer.sendKeyEnd) + ' / accepts ' + keyEnd(peer.acceptKeyEnd);
    const remove = document.createElement('button');
    remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove ' + peer.name);
    remove.onclick = async () => {
      if (await call('DELETE', '/api/peers/' + encodeURIComponent(peer.name))) { say(peer.name + ' is off the allowed list. Its next request is refused.'); load(); }
    };
    tr.insertCell().append(remove);
    return tr;
  }));
}
$('make').onclick = async () => {
  const made = await call('POST', '/api/invites');
  if (!made) return;
  $('made').hidden = false; $('link').value = made.link; $('link').select();
  say('The invite link is ready.');
};
$('copy').onclick = async () => { await navigator.clipboard.writeText($('link').value); say('Copied.'); };
$('accept').onsubmit = async (event) => {
  event.preventDefault();
  say('Connecting\\u2026');
  const peer = await call('POST', '/api/invites/accept', { link: $('paste').value.trim() });
  if (!peer) return;
  $('paste').value = '';
  say(peer.name + ' is on your allowed list, and you are on the allowed list of ' + peer.name + '.');
  load();
};
$('add').onsubmit = async (event) => {
  event.preventDefault();
  const added = await call('POST', '/api/peers', { name: $('name').value.trim(), address: $('address').value.trim(), sendKey: $('key').value });
  if (!added) return;
  $('add').reset();
  say(added.name + ' is on your allowed list.');
  load();
};
load();
</script>
</body>
</html>
`;
