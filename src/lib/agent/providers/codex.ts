import {
  ensureCodexInstalled,
  getCodexAppStatus,
  readCodexThreadHistory,
  startCodexLogin,
  streamCodexChat,
} from '@/lib/agent/codex';

import type { AgentAdapter } from './types';

export const codexAdapter: AgentAdapter = {
  provider: 'codex',
  metadata: {
    id: 'codex',
    label: 'Codex CLI',
    description: 'Official OpenAI coding agent runtime.',
    available: true,
  },
  getStatus: getCodexAppStatus,
  ensureInstalled: ensureCodexInstalled,
  startLogin: async () => {
    const login = await startCodexLogin();
    return {
      kind: 'browser',
      authUrl: login.authUrl,
      loginId: login.loginId,
      message: 'Finish the ChatGPT sign-in, then return here.',
    };
  },
  readThreadHistory: readCodexThreadHistory,
  streamChat: streamCodexChat,
};
