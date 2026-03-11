import { normalizePreviewUrl } from './url.ts';

const LOCAL_PREVIEW_URL_PATTERN = /Local:\s+(https?:\/\/\S+)/gi;
const GENERIC_PREVIEW_URL_PATTERN = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[A-Za-z0-9.-]+):\d+\S*)/gi;

function normalizeLocalPreviewHost(url: string): string {
  return url
    .replace('0.0.0.0', 'localhost')
    .replace('127.0.0.1', 'localhost')
    .replace('[::1]', 'localhost');
}

export function inferPreviewUrlFromTerminalText(text: string): string | null {
  const normalizedText = text.trim();
  if (!normalizedText) return null;

  const localMatches = Array.from(normalizedText.matchAll(LOCAL_PREVIEW_URL_PATTERN));
  const lastLocalMatch = localMatches.at(-1);
  if (lastLocalMatch?.[1]) {
    return normalizePreviewUrl(normalizeLocalPreviewHost(lastLocalMatch[1]));
  }

  const genericMatches = Array.from(normalizedText.matchAll(GENERIC_PREVIEW_URL_PATTERN));
  const lastGenericMatch = genericMatches.at(-1);
  if (lastGenericMatch?.[1]) {
    return normalizePreviewUrl(normalizeLocalPreviewHost(lastGenericMatch[1]));
  }

  return null;
}

export function terminalTranscriptContainsCommand(text: string, command: string): boolean {
  const normalizedText = text.trim();
  const normalizedCommand = command.trim();
  if (!normalizedText || !normalizedCommand) return false;
  return normalizedText.includes(normalizedCommand);
}
