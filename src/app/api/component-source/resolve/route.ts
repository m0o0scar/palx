import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);

type ResolveComponentSourceRequestBody = {
  componentName?: string;
  componentNames?: string[];
  workspaceRoot?: string;
};

const SEARCH_GLOBS = [
  '!**/node_modules/**',
  '!**/.git/**',
  '!**/.next/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/coverage/**',
  '*.{ts,tsx,js,jsx,mjs,cjs}',
];
const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'] as const;
const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
]);
const MAX_WALKED_FILES = 10000;
const MAX_FILE_BYTES = 512 * 1024;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toKebabCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();

const unique = (items: string[]): string[] => Array.from(new Set(items));

const normalizeComponentLookupName = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';

  const match = trimmed.match(/[A-Za-z_$][\w$]*/);
  return match ? match[0] : '';
};

const toPascalCase = (value: string): string =>
  value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment[0] ? segment[0].toUpperCase() + segment.slice(1) : '')
    .join('');

const buildSearchPatterns = (componentName: string): string[] => {
  const escaped = escapeRegex(componentName);

  return [
    `\\bexport\\s+(?:default\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`,
    `\\b(?:async\\s+)?function\\s+${escaped}\\b`,
    `\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>`,
    `\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?[A-Za-z_$][\\w$]*\\s*=>`,
    `\\b(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:memo|forwardRef)\\s*\\(`,
    `\\bexport\\s+default\\s+${escaped}\\b`,
    `\\bclass\\s+${escaped}\\b`,
  ];
};

const buildRgArgs = (pattern: string): string[] => {
  const args = [
    '-l',
    '--no-messages',
    '--pcre2',
  ];

  for (const glob of SEARCH_GLOBS) {
    args.push('--glob', glob);
  }

  args.push(pattern, '.');
  return args;
};

const buildDirectCandidates = (componentName: string): string[] => {
  const kebab = toKebabCase(componentName);
  const pascal = toPascalCase(componentName);
  const snake = componentName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();

  const baseDirs = [
    'src/components',
    'components',
    'src',
  ];
  const baseNames = unique([kebab, pascal, snake, componentName]);
  const candidates: string[] = [];

  for (const dir of baseDirs) {
    for (const base of baseNames) {
      for (const ext of SOURCE_EXTENSIONS) {
        candidates.push(`${dir}/${base}${ext}`);
      }
    }
  }

  return candidates;
};

const fileExists = async (absolutePath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(absolutePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const runPatternSearch = async (workspaceRoot: string, pattern: string): Promise<string[]> => {
  try {
    const { stdout } = await execFileAsync('rg', buildRgArgs(pattern), {
      cwd: workspaceRoot,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 20000,
    });

    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const walkSourceFiles = async (workspaceRoot: string): Promise<string[]> => {
  const files: string[] = [];
  const queue: string[] = [workspaceRoot];

  while (queue.length > 0 && files.length < MAX_WALKED_FILES) {
    const currentDir = queue.shift();
    if (!currentDir) continue;

    let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIR_NAMES.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;

      files.push(fullPath);
      if (files.length >= MAX_WALKED_FILES) break;
    }
  }

  return files;
};

const searchByScanningFiles = async (workspaceRoot: string, componentName: string): Promise<string[]> => {
  const files = await walkSourceFiles(workspaceRoot);
  if (files.length === 0) return [];

  const regexes = buildSearchPatterns(componentName).map((pattern) => {
    try {
      return new RegExp(pattern, 'm');
    } catch {
      return null;
    }
  }).filter((entry): entry is RegExp => entry instanceof RegExp);

  if (regexes.length === 0) return [];

  const matches: string[] = [];
  for (const absolutePath of files) {
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(absolutePath, 'utf-8');
      if (regexes.some((regex) => regex.test(content))) {
        matches.push(path.relative(workspaceRoot, absolutePath));
      }
    } catch {
      // Ignore unreadable files
    }
  }

  return matches;
};

const scoreCandidate = (candidatePath: string, componentName: string): number => {
  const normalized = candidatePath.replace(/\\/g, '/').toLowerCase();
  const kebabName = toKebabCase(componentName);
  const fileName = path.basename(normalized);

  let score = 0;
  if (normalized.includes('/src/components/')) score += 100;
  if (normalized.includes('/components/')) score += 80;
  if (normalized.includes('/src/')) score += 60;
  if (/\.(tsx|jsx)$/.test(normalized)) score += 20;
  if (fileName.includes(kebabName)) score += 15;
  if (fileName.includes(componentName.toLowerCase())) score += 10;
  if (normalized.includes('/node_modules/')) score -= 1000;

  return score;
};

const pickBestCandidate = (workspaceRoot: string, componentName: string, relativePaths: string[]): string | null => {
  const absoluteCandidates = unique(relativePaths)
    .map((relativePath) => path.resolve(workspaceRoot, relativePath))
    .filter(Boolean);

  if (absoluteCandidates.length === 0) return null;

  const sorted = absoluteCandidates.sort((a, b) => {
    const scoreDiff = scoreCandidate(b, componentName) - scoreCandidate(a, componentName);
    if (scoreDiff !== 0) return scoreDiff;
    return a.length - b.length;
  });

  return sorted[0] || null;
};

const resolveSourcePathByComponentName = async (
  workspaceRoot: string,
  componentName: string
): Promise<string | null> => {
  const directCandidates = buildDirectCandidates(componentName);
  for (const candidate of directCandidates) {
    const absolute = path.resolve(workspaceRoot, candidate);
    if (await fileExists(absolute)) {
      return absolute;
    }
  }

  const patterns = buildSearchPatterns(componentName);
  let candidates: string[] = [];

  for (const pattern of patterns) {
    const matches = await runPatternSearch(workspaceRoot, pattern);
    if (matches.length > 0) {
      candidates = matches;
      break;
    }
  }

  if (candidates.length === 0) {
    candidates = await searchByScanningFiles(workspaceRoot, componentName);
  }

  const best = pickBestCandidate(workspaceRoot, componentName, candidates);
  return best;
};

export async function POST(request: NextRequest) {
  let body: ResolveComponentSourceRequestBody;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
  }

  const componentNames = Array.isArray(body.componentNames)
    ? body.componentNames.map((n) => typeof n === 'string' ? normalizeComponentLookupName(n) : '').filter(Boolean)
    : [];

  const componentName = typeof body.componentName === 'string'
    ? normalizeComponentLookupName(body.componentName)
    : '';

  const namesToResolve = componentNames.length > 0 ? componentNames : (componentName ? [componentName] : []);
  const workspaceRoot = typeof body.workspaceRoot === 'string' ? body.workspaceRoot.trim() : '';

  if (namesToResolve.length === 0) {
    return NextResponse.json({ error: 'componentName or componentNames is required' }, { status: 400 });
  }

  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
    return NextResponse.json({ error: 'workspaceRoot must be an absolute path' }, { status: 400 });
  }

  try {
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: 'workspaceRoot must be a directory' }, { status: 400 });
    }

    for (const name of namesToResolve) {
      const sourcePath = await resolveSourcePathByComponentName(workspaceRoot, name);
      if (sourcePath) {
        return NextResponse.json({ sourcePath, resolvedName: name });
      }
    }

    return NextResponse.json({ error: 'Source file not found' }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve component source';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
