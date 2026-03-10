# Operations

## Local Development Setup

Prerequisites (from README and launcher logic):
- Node.js + npm ([README.md](../../README.md), [package.json](../../package.json)).
- `ttyd` installed and available in `PATH`.
- `tmux` for persistent terminal mode.
- Optional Auth0 app credentials for protected mode.

Install and run:

```bash
npm install
npm run dev
```

Alternative CLI run:

```bash
npm run cli
# or
npx vibe-pal
```

CLI can auto-install missing `ttyd`/`tmux` depending on platform strategy ([bin/viba.mjs](../../bin/viba.mjs)).

## Build, Test, and Lint

From [package.json](../../package.json):

```bash
npm run lint
npm test
npm run build
npm run start
```

Other useful scripts:

```bash
npm run prepack
npm run pack:preview
```

Test entrypoints:
- Node tests over TS + MJS: `node --experimental-strip-types --test src/**/*.test.ts test/**/*.test.mjs`.

## Runtime Ports and Processes

- App default port: `3200`.
- Dev mode can auto-select next free port if `3200` is occupied (launcher behavior).
- ttyd port: `7681` (started by server action and proxied by Next rewrite `/terminal/*`).
- Preview proxy and notification socket servers use dynamic ephemeral ports on `127.0.0.1`.

References:
- [bin/viba.mjs](../../bin/viba.mjs)
- [src/app/actions/git.ts](../../src/app/actions/git.ts)
- [next.config.mjs](../../next.config.mjs)
- [src/lib/previewProxyServer.ts](../../src/lib/previewProxyServer.ts)
- [src/lib/sessionNotificationServer.ts](../../src/lib/sessionNotificationServer.ts)

## Deploy/Release Process

This repository uses GitHub Actions release automation:
- On `main` push, workflow bumps minor version, tags, and pushes:
- [.github/workflows/release-on-main-merge.yml](../../.github/workflows/release-on-main-merge.yml)
- Publish workflow publishes to npm from release tag context:
- [.github/workflows/publish-on-tag.yml](../../.github/workflows/publish-on-tag.yml)

NPM package expectations:
- Package includes prebuilt `.next` artifacts per `files` list in [package.json](../../package.json).
- `vibe-pal` production start assumes `.next/BUILD_ID` exists ([bin/viba.mjs](../../bin/viba.mjs)).

## Config, Secrets, and Environments

### Environment variables

Auth0-related:
- `AUTH0_DOMAIN`
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`
- `AUTH0_SECRET`
- `APP_BASE_URL`

Runtime/launcher:
- `PORT`
- `BROWSER` (`none|false|0` disables auto-open)
- `CODEX_HOME` (skills path override)

Session terminal env injection (derived at runtime):
- `GITHUB_TOKEN` or `GITLAB_TOKEN` for git auth.
- `OPENAI_API_KEY` and optional `OPENAI_BASE_URL` for Codex API access.

References:
- [README.md](../../README.md)
- [src/lib/auth0.ts](../../src/lib/auth0.ts)
- [src/app/actions/git.ts](../../src/app/actions/git.ts)
- [src/lib/terminal-session.ts](../../src/lib/terminal-session.ts)

### Local state locations

- `~/.viba/palx.db` (SQLite metadata/config database)
- `~/.viba/session-prompts/*`
- `~/.viba/repos/*` (default clone destination for remote repository onboarding)

Legacy note:
- old JSON metadata files (for example `config.json`, `sessions/*`, `drafts/*`, credential metadata JSON) are migration inputs only; runtime source of truth is `palx.db` once migration has run.

## Troubleshooting Guide

### App inaccessible / unauthorized
- If Auth0 vars are incomplete, app runs unprotected and shows warning banner on home page ([src/app/page.tsx](../../src/app/page.tsx)).
- If Auth0 is configured and API calls return `401`, verify session and callback/logout URLs; middleware protects most routes ([src/proxy.ts](../../src/proxy.ts)).

### Terminal not loading
- Check `ttyd` availability and process startup errors from `startTtydProcess` ([src/app/actions/git.ts](../../src/app/actions/git.ts)).
- Missing `tmux` degrades to shell mode; persistence features differ.
- Verify Next rewrite for `/terminal` is active ([next.config.mjs](../../next.config.mjs)).

### Git operations failing with lock file
- UI exposes lock cleanup action that triggers `cleanup-lock-file` API action ([src/hooks/use-git.ts](../../src/hooks/use-git.ts), [src/lib/git.ts](../../src/lib/git.ts)).

### Credential-related push/clone failures
- Ensure keytar is available; metadata without keychain secret behaves like missing token.
- Re-save credential from credentials page to verify token with provider API.
- Check repository-level `credentialId` selection in config/repo settings.

### Local metadata DB issues
- Verify `~/.viba/palx.db` exists and is writable by the current user.
- If migration was interrupted, restart Palx to re-run DB initialization/migration logic in [src/lib/local-db.ts](../../src/lib/local-db.ts).

### Preview not loading
- Preview URL must normalize to `http/https`; invalid schemes are rejected.
- Ensure target app is reachable from local machine.
- Proxy start endpoint returns explicit JSON error on failure.

### Notifications not arriving
- Ensure session page has active socket (`GET /api/notifications/socket`) and browser notification permission is granted.
- Session notifications are emitted from Palx-managed agent runtime transitions; no external notification ingress exists.
