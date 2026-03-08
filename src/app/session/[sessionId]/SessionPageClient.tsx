'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import { SessionView } from '@/components/SessionView';
import { SessionMetadata } from '@/app/actions/session';
import { getSessionPageBootstrap, type SessionPageBootstrapResult } from '@/app/actions/session-page';
import { clearPendingSessionNavigation } from '@/lib/session-navigation';

type SessionNotificationPayload = {
    type: 'session-notification';
    sessionId: string;
    title: string;
    description: string;
    timestamp: string;
};

const SESSION_FALLBACK_FAVICON_PATH = '/repo-generic-icon.svg';
const APP_DEFAULT_FAVICON_PATH = '/palx-icon.png';
const SESSION_FAVICON_DATA_ATTR = 'data-viba-session-favicon';
const sessionBootstrapResultCache = new Map<string, Extract<SessionPageBootstrapResult, { success: true }>>();
const sessionBootstrapPromiseCache = new Map<string, Promise<SessionPageBootstrapResult>>();

function withFaviconCacheBuster(href: string, key: string): string {
    const separator = href.includes('?') ? '&' : '?';
    return `${href}${separator}${key}=${Date.now()}`;
}

function upsertManagedFaviconLink(rel: 'icon' | 'shortcut icon', href: string): void {
    const selector = `link[rel="${rel}"][${SESSION_FAVICON_DATA_ATTR}="1"]`;
    const existing = document.head.querySelector(selector) as HTMLLinkElement | null;
    if (existing) {
        existing.href = href;
        return;
    }

    const link = document.createElement('link');
    link.rel = rel;
    link.href = href;
    link.setAttribute(SESSION_FAVICON_DATA_ATTR, '1');
    document.head.appendChild(link);
}

function applySessionFavicon(href: string): void {
    upsertManagedFaviconLink('icon', href);
    upsertManagedFaviconLink('shortcut icon', href);
}

function clearManagedSessionFavicons(): void {
    document.head.querySelectorAll(`link[${SESSION_FAVICON_DATA_ATTR}="1"]`).forEach((node) => {
        node.remove();
    });
}

function restoreAppFavicon(): void {
    clearManagedSessionFavicons();
    const defaultHref = withFaviconCacheBuster(APP_DEFAULT_FAVICON_PATH, 'viba-app-favicon');
    const defaultIconLink = document.head.querySelector(`link[rel="icon"]:not([${SESSION_FAVICON_DATA_ATTR}])`) as HTMLLinkElement | null;
    if (defaultIconLink) {
        defaultIconLink.href = defaultHref;
    }
}

function loadSessionPageBootstrapCached(sessionId: string): Promise<SessionPageBootstrapResult> {
    const cached = sessionBootstrapResultCache.get(sessionId);
    if (cached) {
        return Promise.resolve(cached);
    }

    const inFlight = sessionBootstrapPromiseCache.get(sessionId);
    if (inFlight) {
        return inFlight;
    }

    const request = getSessionPageBootstrap(sessionId)
        .then((result) => {
            if (result.success) {
                sessionBootstrapResultCache.set(sessionId, result);
            }
            return result;
        })
        .finally(() => {
            sessionBootstrapPromiseCache.delete(sessionId);
        });

    sessionBootstrapPromiseCache.set(sessionId, request);
    return request;
}

export default function SessionPage() {
    const params = useParams<{ sessionId: string }>();
    const searchParams = useSearchParams();
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
    const [contextSessionMode, setContextSessionMode] = useState<'fast' | 'plan' | undefined>(undefined);
    const [contextAttachmentPaths, setContextAttachmentPaths] = useState<string[]>([]);
    const [projectGitRepoRelativePaths, setProjectGitRepoRelativePaths] = useState<string[]>([]);

    // True = send --resume to agent; False = send fresh start params
    const [isResume, setIsResume] = useState<boolean>(true);
    const [terminalPersistenceMode, setTerminalPersistenceMode] = useState<'tmux' | 'shell'>('shell');
    const [repoDisplayName, setRepoDisplayName] = useState<string | undefined>(undefined);
    const [sessionFaviconHref, setSessionFaviconHref] = useState<string>(SESSION_FALLBACK_FAVICON_PATH);
    const isFreshNavigation = searchParams.get('fresh') === '1';

    const handleOpenSessionNotification = useCallback(() => {
        if (!sessionId) return;

        window.focus();
        const targetPath = `/session/${sessionId}`;
        if (window.location.pathname !== targetPath) {
            router.push(targetPath);
        }
    }, [router, sessionId]);

    useEffect(() => {
        document.documentElement.classList.add('session-page');
        return () => {
            document.documentElement.classList.remove('session-page');
        };
    }, []);

    useEffect(() => {
        const cacheBustedFavicon = withFaviconCacheBuster(sessionFaviconHref, 'viba-session-favicon');
        applySessionFavicon(cacheBustedFavicon);
    }, [sessionFaviconHref]);

    useEffect(() => {
        return () => {
            restoreAppFavicon();
        };
    }, []);

    useEffect(() => {
        if (!sessionId) return;
        clearPendingSessionNavigation(sessionId);
    }, [isFreshNavigation, sessionId]);

    useEffect(() => {
        if (!isFreshNavigation || !sessionId) return;

        const nextUrl = `/session/${encodeURIComponent(sessionId)}`;
        window.history.replaceState(window.history.state, '', nextUrl);
    }, [isFreshNavigation, sessionId]);

    useEffect(() => {
        if (!sessionId) return;

        let cancelled = false;
        let socket: WebSocket | null = null;
        let reconnectTimer: number | null = null;
        let reconnectAttempt = 0;
        let browserNotification: Notification | null = null;

        const clearReconnectTimer = () => {
            if (reconnectTimer === null) return;
            window.clearTimeout(reconnectTimer);
            reconnectTimer = null;
        };

        const scheduleReconnect = () => {
            if (cancelled) return;
            const delay = Math.min(10000, 1000 * (2 ** reconnectAttempt));
            reconnectAttempt += 1;
            reconnectTimer = window.setTimeout(() => {
                reconnectTimer = null;
                void connect();
            }, delay);
        };

        const showBrowserNotification = async (payload: SessionNotificationPayload) => {
            if (!('Notification' in window)) return;

            let permission = Notification.permission;
            if (permission === 'default') {
                permission = await Notification.requestPermission();
            }
            if (permission !== 'granted') return;

            if (browserNotification) {
                browserNotification.close();
            }

            browserNotification = new Notification(payload.title, {
                body: payload.description,
                tag: `viba-session-notification-${payload.sessionId}`,
            });
            browserNotification.onclick = (event) => {
                event.preventDefault();
                handleOpenSessionNotification();
                browserNotification?.close();
            };
        };

        const handleIncomingNotification = (payload: SessionNotificationPayload) => {
            void showBrowserNotification(payload);
        };

        const connect = async () => {
            try {
                const response = await fetch(
                    `/api/notifications/socket?sessionId=${encodeURIComponent(sessionId)}`,
                    { cache: 'no-store' }
                );
                if (!response.ok) {
                    throw new Error('Failed to initialize notification socket');
                }

                const data = await response.json() as { wsUrl?: string };
                if (!data.wsUrl) {
                    throw new Error('Notification socket URL missing');
                }

                if (cancelled) return;

                socket = new WebSocket(data.wsUrl);
                socket.onopen = () => {
                    reconnectAttempt = 0;
                    clearReconnectTimer();
                };
                socket.onerror = () => {
                    socket?.close();
                };
                socket.onclose = () => {
                    if (cancelled) return;
                    scheduleReconnect();
                };
                socket.onmessage = (event) => {
                    try {
                        const payload = JSON.parse(event.data as string) as Partial<SessionNotificationPayload>;
                        if (
                            payload.type !== 'session-notification' ||
                            payload.sessionId !== sessionId ||
                            typeof payload.title !== 'string' ||
                            !payload.title.trim() ||
                            typeof payload.description !== 'string' ||
                            !payload.description.trim() ||
                            typeof payload.timestamp !== 'string'
                        ) {
                            return;
                        }

                        handleIncomingNotification(payload as SessionNotificationPayload);
                    } catch {
                        // Ignore malformed notification messages.
                    }
                };
            } catch {
                scheduleReconnect();
            }
        };

        void connect();

        return () => {
            cancelled = true;
            clearReconnectTimer();
            socket?.close();
            browserNotification?.close();
        };
    }, [handleOpenSessionNotification, sessionId]);

    useEffect(() => {
        if (!sessionId) return;

        let cancelled = false;

        const loadSession = async () => {
            try {
                setSessionFaviconHref(SESSION_FALLBACK_FAVICON_PATH);
                setTerminalSources(null);

                const bootstrap = await loadSessionPageBootstrapCached(sessionId);
                if (cancelled) return;
                if (!bootstrap.success) {
                    setError(bootstrap.error);
                    setLoading(false);
                    return;
                }

                setTerminalPersistenceMode(bootstrap.terminalPersistenceMode);
                setMetadata(bootstrap.metadata);
                setRepoDisplayName(bootstrap.repoDisplayName || undefined);
                setTerminalSources(bootstrap.terminalSources);
                setProjectGitRepoRelativePaths(bootstrap.projectGitRepoRelativePaths);
                setIsResume(isFreshNavigation ? false : bootstrap.isResume);

                if (bootstrap.sessionIconPath) {
                    setSessionFaviconHref(`/api/file-thumbnail?path=${encodeURIComponent(bootstrap.sessionIconPath)}`);
                } else {
                    setSessionFaviconHref(SESSION_FALLBACK_FAVICON_PATH);
                }

                const launchContext = bootstrap.launchContext;
                setInitialMessage(launchContext?.initialMessage);
                setStartupScript(launchContext?.startupScript);
                setContextTitle(launchContext?.title);
                setContextAgentProvider(launchContext?.agentProvider);
                setContextSessionMode(launchContext?.sessionMode);
                setContextAttachmentPaths(launchContext?.attachmentPaths || []);

                if (cancelled) return;
                setLoading(false);
            } catch (e) {
                if (cancelled) return;
                console.error('Failed to load session:', e);
                setError('Failed to load session');
                setLoading(false);
            }
        };

        void loadSession();

        return () => {
            cancelled = true;
        };
    }, [isFreshNavigation, sessionId]);

    const handleExit = (force?: boolean) => {
        if (force) {
            router.replace('/');
        } else {
            router.push('/');
        }
    };

    if (loading) {
        return (
            <div className="flex h-screen w-full items-center justify-center bg-[#f6f6f8] dark:bg-[#0d1117]">
                <div className="flex flex-col items-center gap-4">
                    <span className="loading loading-spinner loading-lg text-primary"></span>
                    <p className="opacity-60 dark:text-slate-400">Loading session...</p>
                </div>
            </div>
        );
    }

    if (error || !metadata) {
        return (
            <div className="flex h-screen w-full items-center justify-center bg-[#f6f6f8] dark:bg-[#0d1117]">
                <div className="card w-96 border border-slate-200 bg-white shadow-xl dark:border-[#30363d] dark:bg-[#161b22]">
                    <div className="card-body items-center text-center">
                        <h2 className="card-title text-error dark:text-red-300">Error</h2>
                        <p className="text-slate-700 dark:text-slate-300">{error || 'Session not found'}</p>
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
            <div className="flex h-screen w-full items-center justify-center bg-[#f6f6f8] dark:bg-[#0d1117]">
                <div className="flex flex-col items-center gap-4">
                    <span className="loading loading-spinner loading-lg text-primary"></span>
                    <p className="opacity-60 dark:text-slate-400">Initializing terminals...</p>
                </div>
            </div>
        );
    }

    return (
        <SessionView
            repo={metadata.projectPath}
            repoDisplayName={repoDisplayName}
            worktree={metadata.workspacePath}
            branch={metadata.branchName || ''}
            baseBranch={metadata.baseBranch}
            workspaceMode={metadata.workspaceMode}
            activeRepoPath={metadata.activeRepoPath}
            gitRepos={metadata.gitRepos}
            sessionName={metadata.sessionName}
            agent={contextAgentProvider || metadata.agent}
            startupScript={startupScript}
            devServerScript={metadata.devServerScript}
            initialMessage={initialMessage}
            attachmentPaths={contextAttachmentPaths}
            projectGitRepoRelativePaths={projectGitRepoRelativePaths}
            title={contextTitle || metadata.title}
            sessionMode={contextSessionMode}
            onExit={handleExit}
            isResume={isResume}
            terminalPersistenceMode={terminalPersistenceMode}
            agentTerminalSrc={terminalSources.agentTerminalSrc}
            floatingTerminalSrc={terminalSources.floatingTerminalSrc}
        />
    );
}
