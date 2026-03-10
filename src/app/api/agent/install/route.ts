import { getAgentAdapter, getDefaultAgentProvider } from '@/lib/agent/providers';
import { errorMessage, jsonLine, streamHeaders } from '@/lib/agent/http';
import type { AgentProvider, InstallStreamEvent } from '@/lib/agent/types';

export const runtime = 'nodejs';

function normalizeProvider(value: unknown): AgentProvider {
  return value === 'codex' || value === 'gemini' || value === 'cursor'
    ? value
    : getDefaultAgentProvider();
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { provider?: AgentProvider };
  const provider = normalizeProvider(body.provider);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: InstallStreamEvent) => controller.enqueue(jsonLine(event));

      try {
        const adapter = getAgentAdapter(provider);
        const currentStatus = await adapter.getStatus();
        if (currentStatus.installed) {
          send({
            type: 'install_completed',
            status: currentStatus,
          });
          controller.close();
          return;
        }

        send({
          type: 'install_started',
          command: currentStatus.installCommand,
        });

        const status = await adapter.ensureInstalled(({ stream, text }) => {
          send({
            type: 'install_log',
            stream,
            text,
          });
        });

        send({
          type: 'install_completed',
          status,
        });
      } catch (error) {
        send({
          type: 'error',
          message: errorMessage(error),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: streamHeaders() });
}
