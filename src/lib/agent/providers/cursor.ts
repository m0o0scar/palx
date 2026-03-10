import {
  ensureAcpInstalled,
  getAcpAppStatus,
  readAcpThreadHistory,
  startAcpLogin,
  streamAcpChat,
} from '@/lib/agent/acp';

import type { AgentAdapter } from './types';

export const cursorAdapter: AgentAdapter = {
  provider: 'cursor',
  metadata: {
    id: 'cursor',
    label: 'Cursor Agent CLI',
    description: "Cursor's coding agent runtime over ACP.",
    available: true,
  },
  getStatus: () => getAcpAppStatus('cursor'),
  ensureInstalled: (onEvent) => ensureAcpInstalled('cursor', onEvent),
  startLogin: () => startAcpLogin('cursor'),
  readThreadHistory: (input) => readAcpThreadHistory('cursor', input),
  streamChat: (input, onEvent, signal, onDiagnostic, onRuntimeUpdate) =>
    streamAcpChat('cursor', input, onEvent, signal, onDiagnostic, onRuntimeUpdate),
};
