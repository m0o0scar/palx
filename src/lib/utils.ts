import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { Project, Repository } from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function getRepoFolderName(repoPath: string): string {
  const normalizedPath = repoPath.replace(/\/+$/, '');
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || repoPath;
}

export async function getRepoDisplayNameFromConfig(repoPath: string): Promise<string> {
  const { getProjectAlias } = await import('@/app/actions/config');
  const alias = await getProjectAlias(repoPath);
  return alias || getRepoFolderName(repoPath);
}

export async function getProjectDisplayNameFromConfig(projectPath: string): Promise<string> {
  const { getProjectAlias } = await import('@/app/actions/config');
  const alias = await getProjectAlias(projectPath);
  return alias || getRepoFolderName(projectPath);
}

export function getProjectDisplayName(project: Pick<Project, 'path' | 'name' | 'displayName'>): string {
  const customName = project.displayName?.trim();
  if (customName) {
    return customName;
  }

  if (project.name?.trim()) {
    return project.name;
  }

  return getRepoFolderName(project.path);
}

export function getRepositoryDisplayName(repo: Pick<Repository, 'path' | 'name' | 'displayName'>): string {
  return getProjectDisplayName(repo);
}

function getNormalizedExtension(filePath: string): string {
  if (!filePath) return '';

  const fileName = filePath.split('/').pop() || '';
  const lastDotIndex = fileName.lastIndexOf('.');

  if (lastDotIndex === -1 || lastDotIndex === 0) {
    return fileName.toLowerCase();
  }

  return fileName.slice(lastDotIndex + 1).toLowerCase();
}

// Known text-based file extensions
const TEXT_EXTENSIONS = new Set([
  // Programming languages
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyw', 'pyi', 'pyx',
  'rb', 'rake', 'gemspec',
  'java', 'kt', 'kts', 'scala', 'sc', 'groovy', 'gradle',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'c++', 'h++',
  'cs', 'fs', 'fsx', 'fsi',
  'go', 'rs', 'swift', 'dart', 'zig', 'nim', 'v', 'odin',
  'php', 'phtml', 'php3', 'php4', 'php5', 'php7', 'phps',
  'pl', 'pm', 'pod', 't', 'psgi',
  'lua', 'tcl', 'r', 'R', 'jl', 'ex', 'exs', 'erl', 'hrl',
  'clj', 'cljs', 'cljc', 'edn', 'lisp', 'lsp', 'el', 'scm', 'ss', 'rkt',
  'hs', 'lhs', 'elm', 'purs', 'ml', 'mli', 'f90', 'f95', 'f03', 'f08', 'for',
  'asm', 's', 'S', 'vhd', 'vhdl', 'v', 'sv', 'svh',
  'bas', 'vb', 'vbs', 'vba',
  'pas', 'pp', 'inc', 'dpr', 'dpk',
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'csh', 'tcsh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd',
  // Web
  'html', 'htm', 'xhtml', 'shtml',
  'css', 'scss', 'sass', 'less', 'styl', 'stylus', 'pcss', 'postcss',
  'svg', 'xml', 'xsl', 'xslt', 'xsd', 'dtd', 'rss', 'atom', 'rdf', 'wsdl', 'soap',
  'vue', 'svelte', 'astro', 'mdx',
  'hbs', 'handlebars', 'mustache', 'ejs', 'pug', 'jade', 'haml', 'slim', 'erb',
  'graphql', 'gql',
  // Data & Config
  'json', 'json5', 'jsonc', 'jsonl', 'ndjson', 'geojson',
  'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'config', 'properties', 'env',
  'csv', 'tsv', 'psv',
  'txt', 'text', 'log', 'out',
  'md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'rst', 'rest', 'adoc', 'asciidoc', 'asc',
  'org', 'tex', 'latex', 'ltx', 'bib', 'sty', 'cls',
  'rtf', 'diff', 'patch',
  // Version control & Build
  'gitignore', 'gitattributes', 'gitmodules', 'gitconfig',
  'dockerignore', 'dockerfile', 'containerfile',
  'editorconfig', 'prettierrc', 'eslintrc', 'babelrc', 'stylelintrc', 'browserslistrc',
  'npmrc', 'nvmrc', 'yarnrc', 'pnpmfile',
  'makefile', 'mk', 'cmake', 'make', 'mak', 'rake', 'podfile', 'gemfile', 'fastfile',
  // Other
  'sql', 'plsql', 'pgsql', 'mysql', 'sqlite', 'hql', 'cql',
  'proto', 'protobuf', 'thrift', 'avro', 'capnp', 'fbs', 'flatc',
  'tf', 'tfvars', 'hcl', 'nomad', 'sentinel',
  'prisma', 'graphqls',
  'lock', // package-lock.json, yarn.lock, etc.
]);

// Known binary file extensions
const BINARY_EXTENSIONS = new Set([
  // Images
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'ico', 'icns', 'tiff', 'tif', 'webp', 'avif', 'heic', 'heif',
  'psd', 'ai', 'eps', 'raw', 'cr2', 'nef', 'orf', 'sr2', 'dng',
  // Video
  'mp4', 'avi', 'mov', 'wmv', 'flv', 'mkv', 'webm', 'm4v', 'mpeg', 'mpg', '3gp', '3g2', 'ogv',
  // Audio
  'mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'wma', 'aiff', 'aif', 'mid', 'midi', 'opus',
  // Archives
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'lz', 'lzma', 'lz4', 'zst', 'cab', 'iso', 'dmg',
  // Executables & Libraries
  'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'obj', 'o',
  'app', 'msi', 'deb', 'rpm', 'apk', 'ipa', 'pkg', 'snap', 'flatpak', 'appimage',
  'class', 'jar', 'war', 'ear', 'pyc', 'pyo', 'pyd', 'beam',
  'wasm', 'wat',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'fon', 'fnt',
  // Database
  'db', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'frm', 'myd', 'myi', 'ibd',
  // Other binary formats
  'bin', 'dat', 'data', 'sav', 'bak',
  'swf', 'fla',
  'blend', 'fbx', 'obj', 'stl', 'gltf', 'glb', '3ds', 'dae', 'ply',
  'sketch', 'fig', 'xd',
  'unity', 'unitypackage', 'asset', 'prefab', 'meta',
]);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'tiff', 'tif', 'webp', 'avif', 'heic', 'heif', 'svg',
]);

/**
 * Determines file type based on extension.
 * @returns 'text' | 'binary' | 'unknown'
 */
export function getFileTypeByExtension(filePath: string): 'text' | 'binary' | 'unknown' {
  if (!filePath) return 'unknown';

  const extension = getNormalizedExtension(filePath);
  
  if (TEXT_EXTENSIONS.has(extension)) {
    return 'text';
  }
  
  if (BINARY_EXTENSIONS.has(extension)) {
    return 'binary';
  }
  
  return 'unknown';
}

/**
 * Check if content appears to be binary (contains null bytes or high ratio of non-printable chars).
 * This is used as a fallback when extension-based detection is inconclusive.
 */
export function isBinaryContent(content: string): boolean {
  if (!content) return false;
  // Check for null bytes - strong indicator of binary content
  if (content.includes('\0')) return true;
  // Check first 8KB for non-printable characters
  const sample = content.slice(0, 8192);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Allow common whitespace (tab, newline, carriage return) and printable ASCII
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
  }
  // If more than 10% non-printable, likely binary
  return sample.length > 0 && (nonPrintable / sample.length) > 0.1;
}

/**
 * Determines if a file is binary, using extension-based detection first,
 * then falling back to content analysis if extension is unknown.
 */
export function isFileBinary(filePath: string, leftContent?: string, rightContent?: string): boolean {
  // First, try to determine from extension
  const fileType = getFileTypeByExtension(filePath);
  
  if (fileType === 'binary') {
    return true;
  }
  
  if (fileType === 'text') {
    return false;
  }
  
  // Extension is unknown - fall back to content analysis
  return isBinaryContent(leftContent || '') || isBinaryContent(rightContent || '');
}

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(getNormalizedExtension(filePath));
}

export function getImageMimeType(filePath: string): string {
  const extension = getNormalizedExtension(filePath);

  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'ico':
      return 'image/x-icon';
    case 'icns':
      return 'image/icns';
    case 'tiff':
    case 'tif':
      return 'image/tiff';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Counts changed lines in a unified git patch.
 * Includes added/removed lines and skips file header markers.
 */
export function getChangedLineCountFromDiff(diff: string | null | undefined): number {
  if (!diff) return 0;

  return diff.split('\n').reduce((count, line) => {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      return count;
    }

    if (line.startsWith('+') || line.startsWith('-')) {
      return count + 1;
    }

    return count;
  }, 0);
}

/**
 * Sanitizes a branch name by replacing illegal Git branch name characters with "-".
 * Git branch names cannot contain:
 * - Space, ~, ^, :, ?, *, [, \, control characters
 * - Double dots (..)
 * - @{ sequence
 * - Leading/trailing dots or slashes
 * - Consecutive slashes
 */
export function sanitizeBranchName(name: string): string {
  const sanitized = name
    // Replace illegal characters with "-"
    .replace(/[\s~^:?*\[\]\\@{}<>|"'`!#$%&()+=;,]/g, '-')
    // Replace double dots with single dash
    .replace(/\.{2,}/g, '-')
    // Replace consecutive slashes with single slash
    .replace(/\/{2,}/g, '/')
    // Replace consecutive dashes with single dash
    .replace(/-{2,}/g, '-');
  
  return sanitized;
}
