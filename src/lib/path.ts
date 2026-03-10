function normalizeInputPath(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isWindowsStylePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.includes('\\');
}

function isWindowsDriveRoot(value: string): boolean {
  return /^[a-zA-Z]:\\$/.test(value);
}

function isUncRoot(value: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+\\?$/.test(value);
}

function isPosixRoot(value: string): boolean {
  return value === '/';
}

function isRootPath(value: string): boolean {
  return isPosixRoot(value) || isWindowsDriveRoot(value) || isUncRoot(value);
}

function normalizeWindowsPath(value: string): string {
  const replaced = value.replace(/\//g, '\\');
  const uncPrefix = replaced.startsWith('\\\\') ? '\\\\' : '';
  const body = uncPrefix ? replaced.slice(2) : replaced;
  const collapsed = body.replace(/\\+/g, '\\');
  return `${uncPrefix}${collapsed}`;
}

function normalizePosixPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function trimTrailingSeparators(value: string, separatorPattern: RegExp): string {
  if (!value || isRootPath(value)) {
    return value;
  }

  return value.replace(separatorPattern, '');
}

export function normalizeFsPathForDisplay(value: string | null | undefined): string {
  const normalizedValue = normalizeInputPath(value);
  if (!normalizedValue) return '';

  return isWindowsStylePath(normalizedValue)
    ? normalizeWindowsPath(normalizedValue)
    : normalizePosixPath(normalizedValue);
}

export function getFsBaseName(value: string | null | undefined): string {
  const normalizedValue = normalizeFsPathForDisplay(value);
  if (!normalizedValue || isRootPath(normalizedValue)) return '';
  if (normalizedValue === '.' || normalizedValue === '..') return normalizedValue;

  const trimmed = isWindowsStylePath(normalizedValue)
    ? trimTrailingSeparators(normalizedValue, /\\+$/)
    : trimTrailingSeparators(normalizedValue, /\/+$/);

  if (!trimmed || isRootPath(trimmed)) return '';

  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || '';
}

export function getFsDirName(value: string | null | undefined): string {
  const normalizedValue = normalizeFsPathForDisplay(value);
  if (!normalizedValue) return '';
  if (normalizedValue === '.' || normalizedValue === '..') return '.';
  if (isRootPath(normalizedValue)) return normalizedValue;

  const isWindows = isWindowsStylePath(normalizedValue);
  const trimmed = isWindows
    ? trimTrailingSeparators(normalizedValue, /\\+$/)
    : trimTrailingSeparators(normalizedValue, /\/+$/);

  const lastSeparatorIndex = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (lastSeparatorIndex === -1) {
    return '.';
  }

  if (!isWindows) {
    return lastSeparatorIndex === 0 ? '/' : trimmed.slice(0, lastSeparatorIndex);
  }

  const dirname = trimmed.slice(0, lastSeparatorIndex);
  if (/^[a-zA-Z]:$/.test(dirname)) {
    return `${dirname}\\`;
  }

  return dirname || trimmed;
}

export function getBaseName(value: string): string {
  return getFsBaseName(value);
}

export function getDirName(value: string): string {
  return getFsDirName(value);
}
