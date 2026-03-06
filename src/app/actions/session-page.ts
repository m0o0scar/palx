'use server';

import { getProjectAlias } from './config';
import { getSessionTerminalSources, resolveRepoCardIcon, startTtydProcess } from './git';
import { discoverProjectGitRepos } from './project';
import { consumeSessionLaunchContext, getSessionMetadata, type SessionMetadata } from './session';

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
    const ttydResult = await startTtydProcess();
    if (!ttydResult.success) {
        return {
            success: false,
            error: 'Failed to start terminal service',
        };
    }

    const metadata = await getSessionMetadata(sessionId);
    if (!metadata) {
        return {
            success: false,
            error: 'Session not found',
        };
    }

    const [terminalSources, repoDisplayName, iconResult] = await Promise.all([
        getSessionTerminalSources(
            metadata.sessionName,
            metadata.activeRepoPath || metadata.projectPath,
            metadata.agent,
        ),
        getProjectAlias(metadata.projectPath),
        resolveRepoCardIcon(metadata.projectPath).catch(() => ({ success: false as const, iconPath: null })),
    ]);

    const isFirstOpen = metadata.initialized === false;
    if (!isFirstOpen) {
        return {
            success: true,
            metadata,
            terminalPersistenceMode: ttydResult.persistenceMode === 'tmux' ? 'tmux' : 'shell',
            terminalSources,
            repoDisplayName,
            sessionIconPath: iconResult.success ? (iconResult.iconPath || null) : null,
            isResume: true,
            launchContext: null,
            projectGitRepoRelativePaths: [],
        };
    }

    const [discoveryResult, launchContextResult] = await Promise.all([
        discoverProjectGitRepos(metadata.projectPath).catch(() => null),
        consumeSessionLaunchContext(sessionId),
    ]);

    const projectGitRepoRelativePaths = discoveryResult
        ? discoveryResult.repos.map((repo) => repo.relativePath)
        : metadata.gitRepos.map((repo) => repo.relativeRepoPath);

    let launchContext: SessionPageLaunchContext | null = null;
    if (launchContextResult.success && launchContextResult.context) {
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

        launchContext = {
            initialMessage: context.initialMessage,
            startupScript: context.startupScript,
            title: context.title,
            agentProvider: context.agentProvider,
            sessionMode: context.sessionMode,
            attachmentPaths: resolvedAttachmentPaths,
        };
    }

    return {
        success: true,
        metadata,
        terminalPersistenceMode: ttydResult.persistenceMode === 'tmux' ? 'tmux' : 'shell',
        terminalSources,
        repoDisplayName,
        sessionIconPath: iconResult.success ? (iconResult.iconPath || null) : null,
        isResume: false,
        launchContext,
        projectGitRepoRelativePaths,
    };
}
