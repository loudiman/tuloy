import { createHash, randomBytes } from 'node:crypto';
import type http from 'node:http';
import { z } from 'zod';
import type { Store } from './store.ts';

const webAddress = z.url({ protocol: /^https?$/ }).transform((address) => address.replace(/\/+$/, ''));
const peerName = z.string().min(1).max(100);

/** What the Tuloy that accepts an invite sends to the Tuloy that made it. `key` is the key that the sender will accept. */
const inviteAnswer = z.object({ name: peerName, address: webAddress, key: z.string().min(20).max(200) });
/** What comes back: the name of the owner that made the invite, and the key that their Tuloy will accept. */
const inviteResult = z.object({ name: peerName, key: z.string().min(20).max(200) });

const NOT_OPEN = 'This invite was used before, or it is older than 24 hours. Ask the other owner for a new invite.';

const newKey = () => randomBytes(32).toString('base64url');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The owner's side of the allowed list: invites. `handle` answers false when the request is not for it.
 * Keys travel only in request and response bodies between the two Tuloys. They are never in a link, an event or an answer to the page.
 */
export function createAllowedList({ store, owner }: { store: Store; owner: string }) {
  return {
    async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
      const json = (status: number, body: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)), true);
      const path = new URL(req.url ?? '/', 'http://tuloy').pathname;
      // ponytail: this Tuloy's address is the loopback socket of the request, as for the agent card. A public address needs a setting.
      const self = `http://${req.socket.localAddress}:${req.socket.localPort}`;
      const token = /^\/invite\/([\w-]+)$/.exec(path)?.[1];

      // The owner removes a peer. The A2A endpoint reads the list on each request, so the peer's next request is refused.
      const toRemove = /^\/api\/peers\/([^/]+)$/.exec(path)?.[1];
      if (req.method === 'DELETE' && toRemove) {
        return store.removePeer(decodeURIComponent(toRemove)) ? (res.writeHead(204).end(), true) : json(404, { error: 'No such peer on the allowed list.' });
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
        const answer = await fetch(link, { method: 'POST', body: JSON.stringify({ name: owner, address: self, key: acceptKey }), signal: AbortSignal.timeout(10_000) });
        if (answer.status === 410) return json(410, { error: NOT_OPEN });
        const result = inviteResult.parse(await answer.json());
        store.addPeer({ name: result.name, address, sendKey: result.key, acceptKey });
        return json(201, { name: result.name, address });
      }

      // The other Tuloy answers the invite. No login: the token is the proof.
      if (req.method === 'POST' && token) {
        const answer = inviteAnswer.safeParse(await readJson(req));
        if (!store.inviteIsOpen(hash(token))) return json(410, { error: NOT_OPEN });
        if (!answer.success) return json(400, { error: 'An answer to an invite needs a name, an address and a key.' });
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
