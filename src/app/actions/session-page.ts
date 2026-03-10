'use server';

import { getProjectAlias } from './config';
import { getSessionTerminalSources, resolveRepoCardIcon } from './git';
import { discoverProjectGitRepos } from './project';
import { consumeSessionLaunchContext, getSessionMetadata, type SessionMetadata } from './session';
import { resolveSessionTerminalRepoPaths } from '@/lib/session-terminal-repos';

type SessionPageLaunchContext = {
    initialMessage?: string;
    startupScript?: string;
    title?: string;
    agentProvider?: string;
    sessionMode?: 'fast' | 'plan';
    attachmentPaths: string[];
};

export type SessionPageBootstrapResult =
    | {
        success: true;
        metadata: SessionMetadata;
        terminalPersistenceMode: 'tmux' | 'shell';
        terminalShellKind: 'posix' | 'powershell';
        terminalSources: {
            agentTerminalSrc: string;
            floatingTerminalSrc: string;
        };
        repoDisplayName: string | null;
        sessionIconPath: string | null;
        isResume: boolean;
        launchContext: SessionPageLaunchContext | null;
        projectGitRepoRelativePaths: string[];
    }
    | {
        success: false;
        error: string;
    };

export async function getSessionPageBootstrap(sessionId: string): Promise<SessionPageBootstrapResult> {
    const metadata = await getSessionMetadata(sessionId);
    if (!metadata) {
        return {
            success: false,
            error: 'Session not found',
        };
    }

    const isFirstOpen = metadata.initialized === false;
    const [repoDisplayName, iconResult, launchContextResult] = await Promise.all([
        getProjectAlias(metadata.projectPath),
        resolveRepoCardIcon(metadata.projectPath).catch(() => ({ success: false as const, iconPath: null })),
        consumeSessionLaunchContext(sessionId),
    ]);

    let launchContext: SessionPageLaunchContext | null = null;
    let launchContextProjectRepoPaths: string[] = [];
    let launchContextProjectRepoRelativePaths: string[] = [];
    if (launchContextResult?.success && launchContextResult.context) {
        const context = launchContextResult.context;
        const launchAttachmentPaths = (context.attachmentPaths || [])
            .map((entry) => entry.trim())
            .filter(Boolean);
        const resolvedAttachmentPaths = launchAttachmentPaths.length > 0
            ? Array.from(new Set(launchAttachmentPaths))
            : Array.from(
                new Set(
                    (context.attachmentNames || [])
                        .map((name) => name.trim())
                        .filter(Boolean)
                        .map((name) => `${metadata.workspacePath}-attachments/${name}`)
                )
            );
        launchContextProjectRepoPaths = (context.projectRepoPaths || [])
            .map((entry) => entry.trim())
            .filter(Boolean);
        launchContextProjectRepoRelativePaths = (context.projectRepoRelativePaths || [])
            .map((entry) => entry.trim());

        launchContext = {
            initialMessage: context.initialMessage,
            startupScript: context.startupScript,
            title: context.title,
            agentProvider: context.agentProvider,
            sessionMode: context.sessionMode,
            attachmentPaths: resolvedAttachmentPaths,
        };
    }

    const discoveryResult = launchContextProjectRepoPaths.length > 0
        ? null
        : await discoverProjectGitRepos(metadata.projectPath).catch(() => null);

    const discoveredProjectRepoPaths = launchContextProjectRepoPaths.length > 0
        ? launchContextProjectRepoPaths
        : (discoveryResult?.repos.map((repo) => repo.repoPath) ?? null);

    const terminalRepoPaths = resolveSessionTerminalRepoPaths({
        sessionRepoPaths: metadata.gitRepos.map((repo) => repo.sourceRepoPath),
        discoveredProjectRepoPaths,
        activeRepoPath: metadata.activeRepoPath,
        projectPath: metadata.projectPath,
    });

    const terminalSources = await getSessionTerminalSources(
        metadata.sessionName,
        terminalRepoPaths,
        metadata.agent,
    );

    const projectGitRepoRelativePaths = launchContextProjectRepoRelativePaths.length > 0
        ? launchContextProjectRepoRelativePaths
        : (discoveryResult
            ? discoveryResult.repos.map((repo) => repo.relativePath)
            : metadata.gitRepos.map((repo) => repo.relativeRepoPath));

    return {
        success: true,
        metadata,
        terminalPersistenceMode: terminalSources.persistenceMode,
        terminalShellKind: terminalSources.shellKind,
        terminalSources: {
            agentTerminalSrc: terminalSources.agentTerminalSrc,
            floatingTerminalSrc: terminalSources.floatingTerminalSrc,
        },
        repoDisplayName,
        sessionIconPath: iconResult.success ? (iconResult.iconPath || null) : null,
        isResume: !isFirstOpen,
        launchContext,
        projectGitRepoRelativePaths,
    };
}
