'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { SessionView } from '@/components/SessionView';
import {
    consumeSessionLaunchContext,
    ensureAgentNotificationMcpSetup,
    getSessionMetadata,
    markSessionInitialized,
    SessionMetadata
} from '@/app/actions/session';
import { getSessionTerminalSources, startTtydProcess } from '@/app/actions/git';

export default function SessionPage() {
    const params = useParams<{ sessionId: string }>();
    const sessionIdParam = params.sessionId;
    const sessionId = Array.isArray(sessionIdParam) ? sessionIdParam[0] : sessionIdParam;
    const router = useRouter();

    const [metadata, setMetadata] = useState<SessionMetadata | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [terminalSources, setTerminalSources] = useState<{
        agentTerminalSrc: string;
        floatingTerminalSrc: string;
    } | null>(null);

    // Startup params — only populated on first open (initialized === false)
    const [initialMessage, setInitialMessage] = useState<string | undefined>(undefined);
    const [startupScript, setStartupScript] = useState<string | undefined>(undefined);
    const [contextTitle, setContextTitle] = useState<string | undefined>(undefined);
    const [contextAgentProvider, setContextAgentProvider] = useState<string | undefined>(undefined);
    const [contextModel, setContextModel] = useState<string | undefined>(undefined);
    const [contextSessionMode, setContextSessionMode] = useState<'fast' | 'plan' | undefined>(undefined);
    const [contextAttachmentNames, setContextAttachmentNames] = useState<string[]>([]);

    // True = send --resume to agent; False = send fresh start params
    const [isResume, setIsResume] = useState<boolean>(true);
    const [terminalPersistenceMode, setTerminalPersistenceMode] = useState<'tmux' | 'shell'>('shell');
    const [agentNotificationMcpScriptPath, setAgentNotificationMcpScriptPath] = useState<string | undefined>(undefined);

    useEffect(() => {
        document.documentElement.classList.add('session-page');
        return () => {
            document.documentElement.classList.remove('session-page');
        };
    }, []);

    useEffect(() => {
        if (!sessionId) return;

        const loadSession = async () => {
            try {
                setTerminalSources(null);
                setAgentNotificationMcpScriptPath(undefined);

                // Ensure ttyd is running
                const ttydResult = await startTtydProcess();
                if (!ttydResult.success) {
                    setError('Failed to start terminal service');
                    setLoading(false);
                    return;
                }
                setTerminalPersistenceMode(ttydResult.persistenceMode === 'tmux' ? 'tmux' : 'shell');

                const data = await getSessionMetadata(sessionId);
                if (!data) {
                    setError('Session not found');
                    setLoading(false);
                    return;
                }

                setMetadata(data);
                const resolvedTerminalSources = await getSessionTerminalSources(data.sessionName, data.repoPath);
                setTerminalSources(resolvedTerminalSources);
                const mcpSetupResult = await ensureAgentNotificationMcpSetup();
                if (mcpSetupResult.success && mcpSetupResult.scriptPath) {
                    setAgentNotificationMcpScriptPath(mcpSetupResult.scriptPath);
                } else {
                    console.error('Failed to setup agent notification MCP integration:', mcpSetupResult.error);
                }
                if (mcpSetupResult.warnings && mcpSetupResult.warnings.length > 0) {
                    for (const warning of mcpSetupResult.warnings) {
                        console.warn(warning);
                    }
                }

                // Determine fresh start vs resume purely from the initialized flag:
                // - initialized === false  → first open, send startup params
                // - initialized === true   → already started before, resume
                // - initialized === undefined → legacy session (no flag), treat as resume
                const isFirstOpen = data.initialized === false;

                if (isFirstOpen) {
                    // Consume the launch context (startup params) written by GitRepoSelector
                    const contextResult = await consumeSessionLaunchContext(sessionId);
                    if (contextResult.success && contextResult.context) {
                        const ctx = contextResult.context;
                        setInitialMessage(ctx.initialMessage);
                        setStartupScript(ctx.startupScript);
                        setContextTitle(ctx.title);
                        setContextAgentProvider(ctx.agentProvider);
                        setContextModel(ctx.model);
                        setContextSessionMode(ctx.sessionMode);
                        setContextAttachmentNames(ctx.attachmentNames || []);
                    }
                    // Whether or not we got context, this is a fresh start
                    setIsResume(false);
                } else {
                    // Already initialized (or legacy) — resume
                    setIsResume(true);
                }

                setLoading(false);
            } catch (e) {
                console.error('Failed to load session:', e);
                setError('Failed to load session');
                setLoading(false);
            }
        };

        loadSession();
    }, [sessionId]);

    const handleExit = (force?: boolean) => {
        if (force) {
            // Force a full page navigation — used after cleanup where
            // router.push can get stuck due to iframe teardown state
            window.location.href = '/';
        } else {
            router.push('/');
        }
    };

    // Called by SessionView once the agent command has been sent for the first time
    const handleSessionStart = async () => {
        if (sessionId) {
            await markSessionInitialized(sessionId);
        }
    };

    if (loading) {
        return (
            <div className="flex h-screen w-full items-center justify-center bg-base-100">
                <div className="flex flex-col items-center gap-4">
                    <span className="loading loading-spinner loading-lg text-primary"></span>
                    <p className="opacity-60">Loading session...</p>
                </div>
            </div>
        );
    }

    if (error || !metadata) {
        return (
            <div className="flex h-screen w-full items-center justify-center bg-base-100">
                <div className="card w-96 bg-base-200 shadow-xl">
                    <div className="card-body items-center text-center">
                        <h2 className="card-title text-error">Error</h2>
                        <p>{error || 'Session not found'}</p>
                        <div className="card-actions justify-end">
                            <button className="btn btn-primary" onClick={() => handleExit()}>Back to Home</button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (!terminalSources) {
        return (
            <div className="flex h-screen w-full items-center justify-center bg-base-100">
                <div className="flex flex-col items-center gap-4">
                    <span className="loading loading-spinner loading-lg text-primary"></span>
                    <p className="opacity-60">Initializing terminals...</p>
                </div>
            </div>
        );
    }

    return (
        <SessionView
            repo={metadata.repoPath}
            worktree={metadata.worktreePath}
            branch={metadata.branchName}
            baseBranch={metadata.baseBranch}
            sessionName={metadata.sessionName}
            agent={contextAgentProvider || metadata.agent}
            model={contextModel || metadata.model}
            startupScript={startupScript}
            devServerScript={metadata.devServerScript}
            initialMessage={initialMessage}
            attachmentNames={contextAttachmentNames}
            title={contextTitle || metadata.title}
            sessionMode={contextSessionMode}
            onExit={handleExit}
            isResume={isResume}
            terminalPersistenceMode={terminalPersistenceMode}
            onSessionStart={handleSessionStart}
            agentTerminalSrc={terminalSources.agentTerminalSrc}
            floatingTerminalSrc={terminalSources.floatingTerminalSrc}
            agentNotificationMcpScriptPath={agentNotificationMcpScriptPath}
        />
    );
}
