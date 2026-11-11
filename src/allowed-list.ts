import { createHash, randomBytes } from 'node:crypto';
import type http from 'node:http';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { z } from 'zod';
import { peersPage } from './peers-page.ts';
import type { Store } from './store.ts';

const webAddress = z.url({ protocol: /^https?$/ }).transform((address) => address.replace(/\/+$/, ''));
const peerName = z.string().min(1).max(100);

/** What the Tuloy that accepts an invite sends to the Tuloy that made it. `key` is the key that the sender will accept. */
const inviteAnswer = z.object({ name: peerName, address: webAddress, key: z.string().min(20).max(200) });
/** What comes back: the name of the owner that made the invite, and the key that their Tuloy will accept. */
const inviteResult = z.object({ name: peerName, key: z.string().min(20).max(200) });

/** An entry that the owner adds by hand. An outside agent that only takes work has no `acceptKey`: it gets a random one that nobody knows. */
const newPeer = z.object({ name: peerName, address: webAddress, sendKey: z.string().min(1), acceptKey: z.string().min(1).optional() });
/** The part of an agent card that the peers screen shows. */
const cardSkills = z.object({ skills: z.array(z.object({ name: z.string().max(200) })).max(100) });

/** What a peer or outside agent lends: the names of the skills on its agent card. Null when the card cannot be read. */
async function lends(address: string): Promise<string[] | null> {
  try {
    const card = await fetch(`${address}/${AGENT_CARD_PATH}`, { signal: AbortSignal.timeout(3000) });
    return cardSkills.parse(await card.json()).skills.map((skill) => skill.name);
  } catch {
    return null;
  }
}

/** The one part of a key that the screen can show: its last 4 characters, and nothing of a short key. */
const keyEnd = (key: string) => (key.length >= 16 ? key.slice(-4) : '');

function decodeName(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

const NOT_OPEN = 'This invite was used before, or it is older than 24 hours. Ask the other owner for a new invite.';

const newKey = () => randomBytes(32).toString('base64url');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The owner's side of the allowed list: read it, add to it, remove from it, and invites. `handle` answers false when the request is not for it.
 * Keys travel only in request and response bodies between the two Tuloys. They are never in a link, an event or an answer to the page.
 */
export function createAllowedList({ store, owner, peerTasksPerHour }: { store: Store; owner: string; peerTasksPerHour: number }) {
  const onList = (name: string) => store.peers().some((peer) => peer.name === name);
  return {
    async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
      const json = (status: number, body: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)), true);
      const path = new URL(req.url ?? '/', 'http://tuloy').pathname;
      // ponytail: this Tuloy's address is the loopback socket of the request, as for the agent card. A public address needs a setting.
      const self = `http://${req.socket.localAddress}:${req.socket.localPort}`;
      const token = /^\/invite\/([\w-]+)$/.exec(path)?.[1];

      if (req.method === 'GET' && path === '/peers') return (res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(peersPage), true);
      // The link, opened in a browser: say what to do with it. It does not use up the invite.
      if (req.method === 'GET' && token) return (res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`This is an invite to the Tuloy of ${owner}. Paste the link into your own Tuloy, on the Peers page.`), true);

      // There is no login on loopback, so a web page that the owner has open could call this API. The browser names that page in Origin.
      const origin = req.headers.origin;
      if (/^\/api\/(peers|invites)\b/.test(path) && req.method !== 'GET' && origin && URL.parse(origin)?.host !== req.headers.host) {
        return json(403, { error: 'Only this Tuloy\'s own page can change the allowed list.' });
      }

      if (req.method === 'GET' && path === '/api/peers') {
        const peers = store.peers().map(async (peer) => ({
          name: peer.name,
          address: peer.address,
          lends: await lends(peer.address),
          tasksInLastHour: store.peerRunsInLastHour(peer.name),
          sendKeyEnd: keyEnd(peer.sendKey),
          acceptKeyEnd: keyEnd(peer.acceptKey),
        }));
        return json(200, { owner, tasksPerHourLimit: peerTasksPerHour, peers: await Promise.all(peers) });
      }
      if (req.method === 'POST' && path === '/api/peers') {
        const peer = newPeer.safeParse(await readJson(req));
        if (!peer.success) return json(400, { error: 'An entry needs a name, a web address and the key to send with.' });
        store.addPeer({ ...peer.data, acceptKey: peer.data.acceptKey ?? newKey() });
        return json(201, { name: peer.data.name, address: peer.data.address });
      }

      // The owner removes a peer. The A2A endpoint reads the list on each request, so the peer's next request is refused.
      const toRemove = /^\/api\/peers\/([^/]+)$/.exec(path)?.[1];
      if (req.method === 'DELETE' && toRemove) {
        return store.removePeer(decodeName(toRemove)) ? (res.writeHead(204).end(), true) : json(404, { error: 'No such peer on the allowed list.' });
      }

      // The owner makes an invite. The token is random; only its hash is stored.
      if (req.method === 'POST' && path === '/api/invites') {
        const made = newKey();
        store.createInvite(hash(made));
        return json(201, { link: `${self}/invite/${made}` });
      }

      // The owner pastes a link from another owner. This Tuloy gives its key to the other Tuloy and gets the other's key back.
      if (req.method === 'POST' && path === '/api/invites/accept') {
        const link = z.object({ link: webAddress }).safeParse(await readJson(req)).data?.link;
        const address = link && /^(https?:\/\/[^/]+)\/invite\/[\w-]+$/.exec(link)?.[1];
        if (!link || !address) return json(400, { error: 'That is not an invite link.' });
        const acceptKey = newKey();
        let answer: Response | undefined;
        let result: z.infer<typeof inviteResult> | undefined;
        try {
          answer = await fetch(link, { method: 'POST', body: JSON.stringify({ name: owner, address: self, key: acceptKey }), signal: AbortSignal.timeout(10_000) });
          result = inviteResult.safeParse(await answer.json()).data;
        } catch {}
        if (answer?.status === 410) return json(410, { error: NOT_OPEN });
        if (answer?.status === 409) return json(409, { error: `The other Tuloy has a peer with the name ${owner} on its allowed list. Its owner must remove that entry first. The invite is still open.` });
        if (!answer?.ok || !result) return json(502, { error: 'The Tuloy that made the invite did not answer as a Tuloy. Check the link and that the other Tuloy is on.' });
        // ponytail: the other side has this Tuloy on its list now and this side refuses. The other owner sees a peer that cannot connect and removes it.
        if (onList(result.name)) return json(409, { error: `A peer with the name ${result.name} is on your allowed list. Remove it first, then ask for a new invite.` });
        store.addPeer({ name: result.name, address, sendKey: result.key, acceptKey });
        return json(201, { name: result.name, address });
      }

      // The other Tuloy answers the invite. No login: the token is the proof.
      if (req.method === 'POST' && token) {
        const answer = inviteAnswer.safeParse(await readJson(req));
        if (!store.inviteIsOpen(hash(token))) return json(410, { error: NOT_OPEN });
        if (!answer.success) return json(400, { error: 'An answer to an invite needs a name, an address and a key.' });
        // An invite adds a peer; it never replaces one. If it did, a person with an invite could take the place of a peer.
        if (onList(answer.data.name)) return json(409, { error: 'A peer with this name is on the allowed list.' });
        // No await from the check to here: two answers at the same time cannot both use the invite.
        if (!store.useInvite(hash(token))) return json(410, { error: NOT_OPEN });
        const acceptKey = newKey();
        store.addPeer({ name: answer.data.name, address: answer.data.address, sendKey: answer.data.key, acceptKey });
        return json(201, { name: owner, key: acceptKey });
      }
      return false;
    },
  };
}

/** The JSON body of a request, or undefined when it is not JSON or is larger than 1 MB. */
export async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
