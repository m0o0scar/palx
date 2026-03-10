import {
  ensureAcpInstalled,
  getAcpAppStatus,
  readAcpThreadHistory,
  startAcpLogin,
  streamAcpChat,
} from '@/lib/agent/acp';

import type { AgentAdapter } from './types';

export const geminiAdapter: AgentAdapter = {
  provider: 'gemini',
  metadata: {
    id: 'gemini',
    label: 'Gemini CLI',
    description: "Google's coding agent runtime over ACP.",
    available: true,
  },
  getStatus: () => getAcpAppStatus('gemini'),
  ensureInstalled: (onEvent) => ensureAcpInstalled('gemini', onEvent),
  startLogin: () => startAcpLogin('gemini'),
  readThreadHistory: (input) => readAcpThreadHistory('gemini', input),
  streamChat: (input, onEvent, signal, onDiagnostic, onRuntimeUpdate) =>
    streamAcpChat('gemini', input, onEvent, signal, onDiagnostic, onRuntimeUpdate),
};
