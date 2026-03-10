import { defaultSpawnEnv } from './common.ts';

export function buildCodexAppServerEnv(extraEnv?: Record<string, string> | null) {
  return defaultSpawnEnv(extraEnv);
}

export function buildAcpSpawnEnv(extraEnv?: Record<string, string> | null) {
  return defaultSpawnEnv(extraEnv);
}
