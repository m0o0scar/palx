export const SESSIONS_UPDATED_EVENT = 'viba:sessions-updated';
const SESSIONS_UPDATED_CHANNEL = 'viba:sessions-updated';
const SESSIONS_UPDATED_TAB_ID_KEY = '__vibaSessionsUpdatedTabId';

type SessionsUpdatedPayload = {
  sourceTabId?: string;
};

function getCurrentTabId(): string {
  if (typeof window === 'undefined') return 'server';
  const runtimeWindow = window as Window & {
    [SESSIONS_UPDATED_TAB_ID_KEY]?: string;
  };
  const existing = runtimeWindow[SESSIONS_UPDATED_TAB_ID_KEY];
  if (existing) return existing;

  const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  runtimeWindow[SESSIONS_UPDATED_TAB_ID_KEY] = generated;
  return generated;
}

export function notifySessionsUpdated(): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent(SESSIONS_UPDATED_EVENT));

  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(SESSIONS_UPDATED_CHANNEL);
    channel.postMessage({ sourceTabId: getCurrentTabId() } satisfies SessionsUpdatedPayload);
    channel.close();
  } catch {
    // Ignore BroadcastChannel failures.
  }
}

export function subscribeToSessionsUpdated(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => { };
  }

  const currentTabId = getCurrentTabId();
  const handleLocalEvent = () => {
    listener();
  };
  window.addEventListener(SESSIONS_UPDATED_EVENT, handleLocalEvent);

  let channel: BroadcastChannel | null = null;
  let channelListener: ((event: MessageEvent<SessionsUpdatedPayload>) => void) | null = null;

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(SESSIONS_UPDATED_CHANNEL);
      channelListener = (event: MessageEvent<SessionsUpdatedPayload>) => {
        if (event.data?.sourceTabId === currentTabId) return;
        listener();
      };
      channel.addEventListener('message', channelListener);
    } catch {
      channel = null;
      channelListener = null;
    }
  }

  return () => {
    window.removeEventListener(SESSIONS_UPDATED_EVENT, handleLocalEvent);
    if (channel && channelListener) {
      channel.removeEventListener('message', channelListener);
    }
    channel?.close();
  };
}
