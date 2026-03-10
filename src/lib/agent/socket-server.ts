import http, { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { URL } from 'node:url';

import { WebSocket, WebSocketServer } from 'ws';

import { getAgentSessionView, subscribeToAgentSession } from '@/lib/agent/runtime';
import type { AgentSocketMessage } from '@/lib/agent/types';

const AGENT_SOCKET_HOST = '127.0.0.1';

type AgentSocketServerState = {
  port: number;
  server: http.Server;
  socketServer: WebSocketServer;
  unsubscribers: WeakMap<WebSocket, () => void>;
};

declare global {
  var __palxAgentSocketServerState: AgentSocketServerState | undefined;
  var __palxAgentSocketServerPromise: Promise<AgentSocketServerState> | undefined;
}

function parseSessionIdFromRequest(request: IncomingMessage) {
  try {
    const requestUrl = new URL(request.url || '/', `ws://${AGENT_SOCKET_HOST}`);
    const sessionId = requestUrl.searchParams.get('sessionId')?.trim();
    return sessionId || null;
  } catch {
    return null;
  }
}

function send(socket: WebSocket, message: AgentSocketMessage) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  try {
    socket.send(JSON.stringify(message));
  } catch {
    socket.close();
  }
}

async function createAgentSocketServer(): Promise<AgentSocketServerState> {
  const unsubscribers = new WeakMap<WebSocket, () => void>();
  const socketServer = new WebSocketServer({ noServer: true });

  socketServer.on('connection', (socket, request) => {
    const sessionId = parseSessionIdFromRequest(request);
    if (!sessionId) {
      socket.close(1008, 'sessionId query parameter is required');
      return;
    }

    if (!getAgentSessionView(sessionId)) {
      socket.close(1008, 'agent session is not registered');
      return;
    }

    const unsubscribe = subscribeToAgentSession(sessionId, (message) => {
      send(socket, message);
    });
    unsubscribers.set(socket, unsubscribe);

    socket.on('close', () => {
      unsubscribers.get(socket)?.();
    });

    socket.on('error', () => {
      unsubscribers.get(socket)?.();
      socket.close();
    });
  });

  const server = http.createServer((_request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Upgrade Required');
  });

  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    socketServer.handleUpgrade(request, socket, head, (wsSocket) => {
      socketServer.emit('connection', wsSocket, request);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, AGENT_SOCKET_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Agent socket server failed to bind to a TCP port'));
        return;
      }

      resolve(address.port);
    });
  });

  return {
    port,
    server,
    socketServer,
    unsubscribers,
  };
}

async function getAgentSocketServerState() {
  const existingState = globalThis.__palxAgentSocketServerState;
  if (existingState && existingState.server.listening) {
    return existingState;
  }

  if (!globalThis.__palxAgentSocketServerPromise) {
    const createPromise = createAgentSocketServer()
      .then((state) => {
        globalThis.__palxAgentSocketServerState = state;
        state.server.once('close', () => {
          if (globalThis.__palxAgentSocketServerState === state) {
            globalThis.__palxAgentSocketServerState = undefined;
          }
        });
        return state;
      })
      .finally(() => {
        if (globalThis.__palxAgentSocketServerPromise === createPromise) {
          globalThis.__palxAgentSocketServerPromise = undefined;
        }
      });
    globalThis.__palxAgentSocketServerPromise = createPromise;
  }

  return globalThis.__palxAgentSocketServerPromise;
}

export async function ensureAgentSocketServer(): Promise<{ wsBaseUrl: string }> {
  const state = await getAgentSocketServerState();
  return { wsBaseUrl: `ws://${AGENT_SOCKET_HOST}:${state.port}` };
}

export function buildAgentSocketWsUrl(wsBaseUrl: string, sessionId: string) {
  const url = new URL(wsBaseUrl);
  url.searchParams.set('sessionId', sessionId);
  return url.toString();
}
