import type http from 'node:http';
import { AGENT_CARD_PATH, AgentCard } from '@a2a-js/sdk';
import { roles } from './schemas.ts';

const skillWords: Record<keyof typeof roles, string> = {
  trend_scout: 'Finds the short-video trends that fit a goal.',
  script: 'Writes one short-video script per trend.',
  reviewer: 'Passes or rejects each script against written criteria.',
  scheduler: 'Makes a posting schedule in Manila time for the scripts that passed.',
};

/** The peer server: the agent card and the A2A endpoint of one Tuloy. `handle` answers false when the request is not for it. */
export function createPeerServer({ owner }: { owner: string }) {
  const card = (address: string) =>
    AgentCard.fromJSON({
      name: `Tuloy of ${owner}`,
      description: `The agents of ${owner}'s Tuloy. Send one task for one agent role.`,
      version: '1.0.0',
      supportedInterfaces: [{ url: `${address}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: Object.keys(roles).map((role) => ({ id: role, name: role.replace('_', ' '), description: skillWords[role as keyof typeof roles], tags: ['tuloy'] })),
      securitySchemes: { key: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { key: { list: [] } } }],
    });

  return {
    async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
      const path = new URL(req.url ?? '/', 'http://tuloy').pathname;
      // ponytail: the address is the loopback socket of this request. A public address needs a setting.
      const address = `http://${req.socket.localAddress}:${req.socket.localPort}`;
      if (req.method === 'GET' && path === `/${AGENT_CARD_PATH}`) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(AgentCard.toJSON(card(address))));
        return true;
      }
      return false;
    },
  };
}
