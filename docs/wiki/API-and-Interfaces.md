# API and Interfaces

## Interface Surface Overview

This codebase exposes three interface categories:
- HTTP APIs in `src/app/api/*`.
- Next.js server actions in `src/app/actions/*` (invoked from client components).
- CLI interface via `vibe-pal` launcher.

## HTTP APIs

### Repository and settings APIs

| Method | Path | Purpose | Main Code |
|---|---|---|---|
| GET | `/api/repos` | List repository records | [src/app/api/repos/route.ts](../../src/app/api/repos/route.ts) |
| POST | `/api/repos` | Add repository record, optional git init | [src/app/api/repos/route.ts](../../src/app/api/repos/route.ts) |
| PUT | `/api/repos` | Update repository metadata/settings fields | [src/app/api/repos/route.ts](../../src/app/api/repos/route.ts) |
| DELETE | `/api/repos` | Remove repository record, optional local folder delete | [src/app/api/repos/route.ts](../../src/app/api/repos/route.ts) |
| POST | `/api/repos/clone` | Clone remote into chosen local path and add record | [src/app/api/repos/clone/route.ts](../../src/app/api/repos/clone/route.ts) |
| GET | `/api/settings` | Get UI settings + resolved default folder | [src/app/api/settings/route.ts](../../src/app/api/settings/route.ts) |
| PUT | `/api/settings` | Update UI settings | [src/app/api/settings/route.ts](../../src/app/api/settings/route.ts) |

### Credentials APIs

| Method | Path | Purpose | Main Code |
|---|---|---|---|
| GET | `/api/credentials` | List credential metadata | [src/app/api/credentials/route.ts](../../src/app/api/credentials/route.ts) |
| POST | `/api/credentials` | Create GitHub/GitLab credential | [src/app/api/credentials/route.ts](../../src/app/api/credentials/route.ts) |
| PUT | `/api/credentials` | Rotate credential token by id | [src/app/api/credentials/route.ts](../../src/app/api/credentials/route.ts) |
| DELETE | `/api/credentials` | Delete credential by id | [src/app/api/credentials/route.ts](../../src/app/api/credentials/route.ts) |
| GET | `/api/credentials/github/repos` | List GitHub repositories for credential | [src/app/api/credentials/github/repos/route.ts](../../src/app/api/credentials/github/repos/route.ts) |

### Git APIs

| Method | Path | Purpose | Main Code |
|---|---|---|---|
| GET | `/api/git/status?path=...` | Working tree status | [src/app/api/git/status/route.ts](../../src/app/api/git/status/route.ts) |
| GET | `/api/git/branches?path=...` | Branch/remotes/tracking/worktrees | [src/app/api/git/branches/route.ts](../../src/app/api/git/branches/route.ts) |
| GET | `/api/git/log?path=...&limit=...&scope=...` | Commit log | [src/app/api/git/log/route.ts](../../src/app/api/git/log/route.ts) |
| GET | `/api/git/diff?...` | Working tree/commit/range diff and image payloads | [src/app/api/git/diff/route.ts](../../src/app/api/git/diff/route.ts) |
| POST | `/api/git/action` | Mutation and read actions via action enum | [src/app/api/git/action/route.ts](../../src/app/api/git/action/route.ts) |

`/api/git/action` supported actions are defined in a Zod enum in [src/app/api/git/action/route.ts](../../src/app/api/git/action/route.ts), including: commit/push/pull/fetch/stage/unstage/checkout/branch/tag/remote ops/reset/revert/cherry-pick/rebase/merge/conflict actions/stash actions/reword/discard/cleanup-lock-file.

### Workspace utility APIs

| Method | Path | Purpose | Main Code |
|---|---|---|---|
| POST | `/api/fs/open` | Open folder in system file manager | [src/app/api/fs/open/route.ts](../../src/app/api/fs/open/route.ts) |
| POST | `/api/fs/open-terminal` | Open folder in system terminal app | [src/app/api/fs/open-terminal/route.ts](../../src/app/api/fs/open-terminal/route.ts) |
| GET | `/api/file-thumbnail?path=...` | Serve local image thumbnail file | [src/app/api/file-thumbnail/route.ts](../../src/app/api/file-thumbnail/route.ts) |
| POST | `/api/component-source/resolve` | Resolve React component name to source file path | [src/app/api/component-source/resolve/route.ts](../../src/app/api/component-source/resolve/route.ts) |

### Preview and notifications APIs

| Method | Path | Purpose | Main Code |
|---|---|---|---|
| POST | `/api/preview-proxy/start` | Ensure local preview proxy and return proxy URL | [src/app/api/preview-proxy/start/route.ts](../../src/app/api/preview-proxy/start/route.ts) |
| GET | `/api/notifications/socket?sessionId=...` | Return WS endpoint for session notification stream | [src/app/api/notifications/socket/route.ts](../../src/app/api/notifications/socket/route.ts) |

## Server Actions Interfaces

Core action groups:
- Session actions: [src/app/actions/session.ts](../../src/app/actions/session.ts).
- Git/session runtime actions: [src/app/actions/git.ts](../../src/app/actions/git.ts).
- Config: [src/app/actions/config.ts](../../src/app/actions/config.ts).
- Credentials wrappers: [src/app/actions/credentials.ts](../../src/app/actions/credentials.ts).
- Drafts: [src/app/actions/draft.ts](../../src/app/actions/draft.ts).
- Repo name/clone helper: [src/app/actions/repository.ts](../../src/app/actions/repository.ts).

These are consumed heavily by:
- [src/components/GitRepoSelector.tsx](../../src/components/GitRepoSelector.tsx)
- [src/components/SessionView.tsx](../../src/components/SessionView.tsx)
- [src/app/session/[sessionId]/SessionPageClient.tsx](../../src/app/session/%5BsessionId%5D/SessionPageClient.tsx)
- [src/app/credentials/page.tsx](../../src/app/credentials/page.tsx)

## CLI Interface

`vibe-pal` launcher interfaces:
- `--dev`
- `--port <n>` / `-p <n>`
- `--help` / `-h`

Implementation:
- parser: [src/lib/cli-args.mjs](../../src/lib/cli-args.mjs)
- launcher: [bin/viba.mjs](../../bin/viba.mjs)

## Authn/Authz Model

- Auth0 is optional; enabled only when required env vars are set (`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`) in [src/lib/auth0.ts](../../src/lib/auth0.ts).
- Middleware enforces session checks on app routes and APIs when configured: [src/proxy.ts](../../src/proxy.ts).

## Validation, Error Shapes, and Status Codes

- Zod validation is used in many API routes (`400` on invalid request payload).
- Git API errors normalized by `handleGitError` helper: [src/lib/api-utils.ts](../../src/lib/api-utils.ts).
- Routes generally return JSON `{ error: string|issues }` on failure.
- Some utility routes return plain `Response` bodies (`/api/file-thumbnail`).

## Versioning

- No explicit API versioning (`/v1`) is implemented.
- Compatibility is currently code-coupled to frontend hooks/components in same repo.
