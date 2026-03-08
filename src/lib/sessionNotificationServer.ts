import http, { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { ChatStreamEvent, SessionAgentRuntimeState } from '@/lib/types';

const NOTIFICATION_SERVER_HOST = '127.0.0.1';

type SessionNotificationServerState = {
  port: number;
  server: http.Server;
  socketServer: WebSocketServer;
  sessionSockets: Map<string, Set<WebSocket>>;
  agentSessionSockets: Map<string, Set<WebSocket>>;
  sessionListSockets: Set<WebSocket>;
};

export type SessionNotificationPayload = {
  type: 'session-notification';
  sessionId: string;
  title: string;
  description: string;
  timestamp: string;
};

export type SessionListUpdatedPayload = {
  type: 'session-list-updated';
  timestamp: string;
};

export type SessionAgentEventPayload = {
  type: 'session-agent-event';
  sessionId: string;
  snapshot: SessionAgentRuntimeState;
  event: ChatStreamEvent;
  timestamp: string;
};

declare global {
  var __vibaSessionNotificationServerState: SessionNotificationServerState | undefined;
  var __vibaSessionNotificationServerPromise: Promise<SessionNotificationServerState> | undefined;
}

function parseSessionIdFromRequest(request: IncomingMessage): string | null {
  try {
    const requestUrl = new URL(request.url || '/', `ws://${NOTIFICATION_SERVER_HOST}`);
    const sessionId = requestUrl.searchParams.get('sessionId')?.trim();
    return sessionId || null;
  } catch {
    return null;
  }
}

function parseChannelFromRequest(request: IncomingMessage): string | null {
  try {
    const requestUrl = new URL(request.url || '/', `ws://${NOTIFICATION_SERVER_HOST}`);
    const channel = requestUrl.searchParams.get('channel')?.trim();
    return channel || null;
  } catch {
    return null;
  }
}

function attachSocketToSession(
  state: SessionNotificationServerState,
  sessionId: string,
  socket: WebSocket
): void {
  const existing = state.sessionSockets.get(sessionId);
  if (existing) {
    existing.add(socket);
    return;
  }

  state.sessionSockets.set(sessionId, new Set([socket]));
}

function detachSocketFromSession(
  state: SessionNotificationServerState,
  sessionId: string,
  socket: WebSocket
): void {
  const sockets = state.sessionSockets.get(sessionId);
  if (!sockets) return;

  sockets.delete(socket);
  if (sockets.size === 0) {
    state.sessionSockets.delete(sessionId);
  }
}

async function createSessionNotificationServer(): Promise<SessionNotificationServerState> {
  const sessionSockets = new Map<string, Set<WebSocket>>();
  const agentSessionSockets = new Map<string, Set<WebSocket>>();
  const sessionListSockets = new Set<WebSocket>();
  const socketServer = new WebSocketServer({ noServer: true });

  socketServer.on('connection', (socket, request) => {
    const channel = parseChannelFromRequest(request);
    if (channel === 'session-list') {
      sessionListSockets.add(socket);
      socket.on('close', () => {
        sessionListSockets.delete(socket);
      });
      socket.on('error', () => {
        sessionListSockets.delete(socket);
      });
      return;
    }

    if (channel === 'agent') {
      const sessionId = parseSessionIdFromRequest(request);
      if (!sessionId) {
        socket.close(1008, 'sessionId query parameter is required');
        return;
      }

      const state = globalThis.__vibaSessionNotificationServerState;
      if (!state) {
        socket.close(1011, 'notification server unavailable');
        return;
      }

      attachSocketToSession(
        {
          ...state,
          sessionSockets: state.agentSessionSockets,
        },
        sessionId,
        socket,
      );

      socket.on('close', () => {
        detachSocketFromSession(
          {
            ...state,
            sessionSockets: state.agentSessionSockets,
          },
          sessionId,
          socket,
        );
      });

      socket.on('error', () => {
        detachSocketFromSession(
          {
            ...state,
            sessionSockets: state.agentSessionSockets,
          },
          sessionId,
          socket,
        );
      });
      return;
    }

    const sessionId = parseSessionIdFromRequest(request);
    if (!sessionId) {
      socket.close(1008, 'sessionId query parameter is required');
      return;
    }

    const state = globalThis.__vibaSessionNotificationServerState;
    if (!state) {
      socket.close(1011, 'notification server unavailable');
      return;
    }

    attachSocketToSession(state, sessionId, socket);

    socket.on('close', () => {
      detachSocketFromSession(state, sessionId, socket);
    });

    socket.on('error', () => {
      detachSocketFromSession(state, sessionId, socket);
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
    server.listen(0, NOTIFICATION_SERVER_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Notification socket server failed to bind to a TCP port'));
        return;
      }

      resolve(address.port);
    });
  });

  return {
    port,
    server,
    socketServer,
    sessionSockets,
    agentSessionSockets,
    sessionListSockets,
  };
}

async function getSessionNotificationServerState(): Promise<SessionNotificationServerState> {
  const existingState = globalThis.__vibaSessionNotificationServerState;
  if (existingState && existingState.server.listening) {
    return existingState;
  }

  if (!globalThis.__vibaSessionNotificationServerPromise) {
    const createPromise = createSessionNotificationServer()
      .then((state) => {
        globalThis.__vibaSessionNotificationServerState = state;
        state.server.once('close', () => {
          if (globalThis.__vibaSessionNotificationServerState === state) {
            globalThis.__vibaSessionNotificationServerState = undefined;
          }
        });
        return state;
      })
      .finally(() => {
        if (globalThis.__vibaSessionNotificationServerPromise === createPromise) {
          globalThis.__vibaSessionNotificationServerPromise = undefined;
        }
      });
    globalThis.__vibaSessionNotificationServerPromise = createPromise;
  }

  return globalThis.__vibaSessionNotificationServerPromise;
}

export async function ensureSessionNotificationServer(): Promise<{ wsBaseUrl: string }> {
  const state = await getSessionNotificationServerState();
  return { wsBaseUrl: `ws://${NOTIFICATION_SERVER_HOST}:${state.port}` };
}

export function buildSessionNotificationWsUrl(wsBaseUrl: string, sessionId: string): string {
  const url = new URL(wsBaseUrl);
  url.searchParams.set('sessionId', sessionId);
  return url.toString();
}

export function buildSessionAgentWsUrl(wsBaseUrl: string, sessionId: string): string {
  const url = new URL(wsBaseUrl);
  url.searchParams.set('channel', 'agent');
  url.searchParams.set('sessionId', sessionId);
  return url.toString();
}

export function buildSessionListNotificationWsUrl(wsBaseUrl: string): string {
  const url = new URL(wsBaseUrl);
  url.searchParams.set('channel', 'session-list');
  return url.toString();
}

export async function publishSessionNotification(input: {
  sessionId: string;
  title: string;
  description: string;
}): Promise<number> {
  const sessionId = input.sessionId.trim();
  const title = input.title.trim();
  const description = input.description.trim();
  if (!sessionId || !title || !description) {
    throw new Error('sessionId, title, and description are required');
  }

  const state = await getSessionNotificationServerState();
  const sockets = state.sessionSockets.get(sessionId);
  if (!sockets || sockets.size === 0) {
    return 0;
  }

  const payload: SessionNotificationPayload = {
    type: 'session-notification',
    sessionId,
    title,
    description,
    timestamp: new Date().toISOString(),
  };
  const serializedPayload = JSON.stringify(payload);

  let delivered = 0;
  const staleSockets: WebSocket[] = [];

  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.OPEN) {
      staleSockets.push(socket);
      continue;
    }

    try {
      socket.send(serializedPayload);
      delivered += 1;
    } catch {
      staleSockets.push(socket);
    }
  }

  for (const staleSocket of staleSockets) {
    sockets.delete(staleSocket);
  }

  if (sockets.size === 0) {
    state.sessionSockets.delete(sessionId);
  }

  return delivered;
}

export async function publishSessionListUpdated(): Promise<number> {
  const state = await getSessionNotificationServerState();
  if (state.sessionListSockets.size === 0) {
    return 0;
  }

  const payload: SessionListUpdatedPayload = {
    type: 'session-list-updated',
    timestamp: new Date().toISOString(),
  };
  const serializedPayload = JSON.stringify(payload);

  let delivered = 0;
  const staleSockets: WebSocket[] = [];

  for (const socket of state.sessionListSockets) {
    if (socket.readyState !== WebSocket.OPEN) {
      staleSockets.push(socket);
      continue;
    }

    try {
      socket.send(serializedPayload);
      delivered += 1;
    } catch {
      staleSockets.push(socket);
    }
  }

  for (const staleSocket of staleSockets) {
    state.sessionListSockets.delete(staleSocket);
  }

  return delivered;
}

export async function publishSessionAgentEvent(input: {
  sessionId: string;
  snapshot: SessionAgentRuntimeState;
  event: ChatStreamEvent;
}): Promise<number> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  const state = await getSessionNotificationServerState();
  const sockets = state.agentSessionSockets.get(sessionId);
  if (!sockets || sockets.size === 0) {
    return 0;
  }

  const payload: SessionAgentEventPayload = {
    type: 'session-agent-event',
    sessionId,
    snapshot: input.snapshot,
    event: input.event,
    timestamp: new Date().toISOString(),
  };
  const serializedPayload = JSON.stringify(payload);

  let delivered = 0;
  const staleSockets: WebSocket[] = [];

  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.OPEN) {
      staleSockets.push(socket);
      continue;
    }

    try {
      socket.send(serializedPayload);
      delivered += 1;
    } catch {
      staleSockets.push(socket);
    }
  }

  for (const staleSocket of staleSockets) {
    sockets.delete(staleSocket);
  }

  if (sockets.size === 0) {
    state.agentSessionSockets.delete(sessionId);
  }

  return delivered;
}
