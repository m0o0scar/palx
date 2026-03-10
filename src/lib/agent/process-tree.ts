export type RuntimeProcessEntry = {
  pid: number;
  ppid: number;
  state: string;
  command: string;
};

const PROCESS_LINE_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/;

export function parsePsProcessTable(output: string): RuntimeProcessEntry[] {
  const byPid = new Map<number, RuntimeProcessEntry>();
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = line.match(PROCESS_LINE_PATTERN);
    if (!match) continue;

    const pid = Number.parseInt(match[1] || '', 10);
    const ppid = Number.parseInt(match[2] || '', 10);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) {
      continue;
    }

    byPid.set(pid, {
      pid,
      ppid,
      state: (match[3] || '').trim(),
      command: (match[4] || '').trim(),
    });
  }

  return Array.from(byPid.values()).sort((a, b) => a.pid - b.pid);
}

export function collectDescendantProcesses(
  entries: RuntimeProcessEntry[],
  rootPid: number,
): RuntimeProcessEntry[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || entries.length === 0) {
    return [];
  }

  const childrenByParent = new Map<number, RuntimeProcessEntry[]>();
  for (const entry of entries) {
    const siblings = childrenByParent.get(entry.ppid);
    if (siblings) {
      siblings.push(entry);
    } else {
      childrenByParent.set(entry.ppid, [entry]);
    }
  }

  const descendants: RuntimeProcessEntry[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  const visited = new Set<number>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (visited.has(current.pid)) continue;
    visited.add(current.pid);

    descendants.push(current);
    const children = childrenByParent.get(current.pid);
    if (children && children.length > 0) {
      queue.push(...children);
    }
  }

  return descendants.sort((a, b) => a.pid - b.pid);
}
