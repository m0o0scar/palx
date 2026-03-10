# Notifications and Session Signals

## What This Feature Does

User-facing behavior:
- Receives in-browser notifications tied to a specific session.
- Displays native browser notifications (when permission granted) for agent completion and attention-needed states.
- Keeps session lists synchronized across tabs/windows via local storage event signaling.

System-facing behavior:
- Derives notification payloads from Palx-managed agent runtime state.
- Spins up an in-process WebSocket server and routes notifications by `sessionId`.

## Key Modules and Responsibilities

- Notification WS side server and fanout:
- [src/lib/sessionNotificationServer.ts](../../../src/lib/sessionNotificationServer.ts)
- Runtime-to-notification derivation:
- [src/lib/agent/session-manager.ts](../../../src/lib/agent/session-manager.ts)
- Notification APIs:
- `GET /api/notifications/socket?sessionId=...` ([src/app/api/notifications/socket/route.ts](../../../src/app/api/notifications/socket/route.ts))
- Session page socket client + browser notification display:
- [src/app/session/[sessionId]/SessionPageClient.tsx](../../../src/app/session/%5BsessionId%5D/SessionPageClient.tsx)
- Tab synchronization helper:
- [src/lib/session-updates.ts](../../../src/lib/session-updates.ts)

## Public Interfaces

### HTTP + WS interfaces
- `GET /api/notifications/socket?sessionId=...`
- Returns JSON with `wsUrl` to connect to.
- WebSocket payload shape:
- `{ type: 'session-notification', sessionId, title, description, timestamp }`

### Browser signaling interface
- `notifySessionsUpdated()` writes `localStorage['viba:sessions-updated-at']` and dispatches `viba:sessions-updated` custom event.

## Data Model and Storage Touches

- Notification subscriptions are in-memory only (`sessionSockets: Map<sessionId, Set<WebSocket>>`).
- Session-update sync uses localStorage key `viba:sessions-updated-at`.

## Main Control Flow

```mermaid
sequenceDiagram
  participant SessionMgr as session_manager
  participant API as api_notifications_socket
  participant Notify as sessionNotificationServer
  participant SessionPage as SessionPageClient
  participant Browser as Notification API

  SessionPage->>API: GET /api/notifications/socket?sessionId=...
  API->>Notify: ensure server + build ws url
  SessionPage->>Notify: open WebSocket

  SessionMgr->>Notify: publishSessionNotification
  Notify-->>SessionPage: WS message
  SessionPage->>Browser: new Notification(title, description)
```

## Error Handling and Edge Cases

- Socket route returns `400` when `sessionId` is missing ([src/app/api/notifications/socket/route.ts](../../../src/app/api/notifications/socket/route.ts)).
- Session client uses reconnect with exponential backoff when socket initialization or connection fails ([src/app/session/[sessionId]/SessionPageClient.tsx](../../../src/app/session/%5BsessionId%5D/SessionPageClient.tsx)).
- Derived notifications are emitted only for completed turns, auth-required states, and terminal errors.

## Observability

- Notification delivery count is returned by `publishSessionNotification(...)` to internal callers.
- Socket and browser-notification failures are silently retried or ignored in client to avoid breaking session load.

## Tests

No dedicated notification server/client tests are present in this branch.
