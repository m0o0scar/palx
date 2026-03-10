# Project Layout

## Repository Structure

```text
.
├── bin/                     # CLI launcher (vibe-pal)
├── src/
│   ├── app/                 # Next.js App Router pages, APIs, server actions
│   ├── components/          # UI components (session, git, file browsers)
│   ├── hooks/               # React Query hooks and browser interaction hooks
│   └── lib/                 # Domain and infrastructure services/utilities
├── public/                  # Static assets/icons
├── docs/                    # Screenshots/evidence/prompts (not wiki)
├── test/                    # Node tests for launcher behavior
└── .github/workflows/       # release/publish workflows
```

Primary references:
- app routes and providers: [src/app](../../src/app)
- UI components: [src/components](../../src/components)
- shared domain code: [src/lib](../../src/lib)
- launcher: [bin/viba.mjs](../../bin/viba.mjs)

## Where Responsibilities Live

### App routes and layouts
- Root shell/theme/bootstrap: [src/app/layout.tsx](../../src/app/layout.tsx), [src/app/globals.css](../../src/app/globals.css).
- Home and new-session flows: [src/app/page.tsx](../../src/app/page.tsx), [src/app/new/page.tsx](../../src/app/new/page.tsx).
- Session route and loader: [src/app/session/[sessionId]/page.tsx](../../src/app/session/%5BsessionId%5D/page.tsx), [src/app/session/[sessionId]/SessionPageClient.tsx](../../src/app/session/%5BsessionId%5D/SessionPageClient.tsx).
- Git workspace routes: [src/app/git/layout.tsx](../../src/app/git/layout.tsx), [src/app/git/page.tsx](../../src/app/git/page.tsx), [src/app/git/changes/page.tsx](../../src/app/git/changes/page.tsx), [src/app/git/history/page.tsx](../../src/app/git/history/page.tsx), [src/app/git/stashes/page.tsx](../../src/app/git/stashes/page.tsx).

### Server actions
- Session metadata/context/worktree lifecycle: [src/app/actions/session.ts](../../src/app/actions/session.ts).
- Git/session runtime actions (`ttyd`, worktree prep, scripts, terminal env): [src/app/actions/git.ts](../../src/app/actions/git.ts).
- Config and repo settings: [src/app/actions/config.ts](../../src/app/actions/config.ts).
- Credentials server-action wrappers: [src/app/actions/credentials.ts](../../src/app/actions/credentials.ts).
- Draft persistence: [src/app/actions/draft.ts](../../src/app/actions/draft.ts).
- Repo name resolution and remote clone flow: [src/app/actions/repository.ts](../../src/app/actions/repository.ts).

### API interfaces
- Git APIs: [src/app/api/git](../../src/app/api/git).
- Repo/settings/credentials APIs: [src/app/api/repos](../../src/app/api/repos), [src/app/api/settings/route.ts](../../src/app/api/settings/route.ts), [src/app/api/credentials/route.ts](../../src/app/api/credentials/route.ts).
- Preview, notifications, FS launch: [src/app/api/preview-proxy/start/route.ts](../../src/app/api/preview-proxy/start/route.ts), [src/app/api/notifications/socket/route.ts](../../src/app/api/notifications/socket/route.ts), [src/app/api/fs/open/route.ts](../../src/app/api/fs/open/route.ts).

### Domain/infrastructure libraries
- Git domain: [src/lib/git.ts](../../src/lib/git.ts), [src/lib/git-log-options.ts](../../src/lib/git-log-options.ts).
- Session terminal helpers: [src/lib/terminal-session.ts](../../src/lib/terminal-session.ts), [src/lib/ttyd-theme.ts](../../src/lib/ttyd-theme.ts).
- Persistence and types: [src/lib/store.ts](../../src/lib/store.ts), [src/lib/types.ts](../../src/lib/types.ts).
- Credentials: [src/lib/credentials.ts](../../src/lib/credentials.ts), [src/lib/agent-api-credentials.ts](../../src/lib/agent-api-credentials.ts).
- Preview + notification side servers: [src/lib/previewProxyServer.ts](../../src/lib/previewProxyServer.ts), [src/lib/sessionNotificationServer.ts](../../src/lib/sessionNotificationServer.ts).
- CLI/non-interactive codex helper: [src/lib/codex-cli.ts](../../src/lib/codex-cli.ts).

### UI component domains
- Session creation and start flow: [src/components/GitRepoSelector.tsx](../../src/components/GitRepoSelector.tsx).
- Active session runtime: [src/components/SessionView.tsx](../../src/components/SessionView.tsx).
- Git history/status UIs: [src/components/git/history-view.tsx](../../src/components/git/history-view.tsx), [src/components/git/status-view.tsx](../../src/components/git/status-view.tsx).
- Session repository side panel: [src/components/SessionRepoViewer.tsx](../../src/components/SessionRepoViewer.tsx).
- Sidebar/workspace navigation: [src/components/layout/sidebar.tsx](../../src/components/layout/sidebar.tsx).

## Entry Points

### Web app runtime
- Next app starts through standard Next commands in [package.json](../../package.json).
- Root middleware and providers are loaded from [src/proxy.ts](../../src/proxy.ts) and [src/app/providers.tsx](../../src/app/providers.tsx).

### CLI runtime
- Executable `vibe-pal` points to [bin/viba.mjs](../../bin/viba.mjs) via `bin` field in [package.json](../../package.json).
- CLI parses args with [src/lib/cli-args.mjs](../../src/lib/cli-args.mjs), ensures `ttyd`/`tmux`, optionally opens browser.

## Configuration Locations

- Next config and rewrites: [next.config.mjs](../../next.config.mjs).
- TypeScript config: [tsconfig.json](../../tsconfig.json).
- ESLint config: [eslint.config.mjs](../../eslint.config.mjs).
- PostCSS/Tailwind plugin setup: [postcss.config.mjs](../../postcss.config.mjs), [src/app/globals.css](../../src/app/globals.css).
- Runtime package scripts/build metadata: [package.json](../../package.json).

## Test Layout

- Unit tests (Node test runner) for lib modules: [src/lib/*.test.ts](../../src/lib).
- Git utility tests in component layer: [src/components/git/pull-all-utils.test.ts](../../src/components/git/pull-all-utils.test.ts).
- CLI tests: [test/bin/viba.test.mjs](../../test/bin/viba.test.mjs).

## Notable Layout Observations

- `src/components/repo-list.tsx` appears unused by current route tree and references `/api/fs` browsing APIs that are not present in this branch; active repository onboarding uses `GitRepoSelector` + server actions instead.
- `src/lib/local-db.ts` is the centralized local metadata/config persistence layer (`~/.viba/palx.db`), while `src/app/actions/session.ts` still writes prompt text files under `~/.viba/session-prompts`.
