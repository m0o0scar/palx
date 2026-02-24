export type TerminalSessionRole = 'agent' | 'terminal';

function sanitizeTmuxSessionName(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  return safe || 'session';
}

export function getTmuxSessionName(sessionName: string, role: TerminalSessionRole): string {
  return `viba-${sanitizeTmuxSessionName(sessionName).slice(0, 40)}-${role}`;
}

export function buildTtydTerminalSrc(sessionName: string, role: TerminalSessionRole): string {
  const tmuxSession = getTmuxSessionName(sessionName, role);
  const params = new URLSearchParams();
  params.append('arg', 'new-session');
  params.append('arg', '-A');
  params.append('arg', '-s');
  params.append('arg', tmuxSession);
  return `/terminal?${params.toString()}`;
}
