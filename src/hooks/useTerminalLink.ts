import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import { normalizePreviewUrl } from '@/lib/url';

export type TerminalWindow = Window & {
    term?: {
        paste: (text: string) => void;
        options: {
            linkHandler?: TerminalLinkHandler | null;
            theme?: Record<string, string>;
            [key: string]: unknown;
        };
        _core?: {
            _linkProviderService?: {
                linkProviders?: Map<number, TerminalLinkProvider>;
            };
        };
    };
};

export type TerminalLinkProvider = {
    _handler?: (event: MouseEvent | undefined, url: string) => void;
    provideLinks?: (line: number, callback: (links: TerminalLink[] | undefined) => void) => void;
};

export type TerminalLink = {
    text: string;
    activate?: (event: MouseEvent | undefined, text: string) => void;
    [key: string]: unknown;
};

export type TerminalLinkHandler = {
    allowNonHttpProtocols?: boolean;
    activate?: (event: MouseEvent | undefined, url: string, range?: unknown) => void;
    hover?: (event: MouseEvent | undefined, url: string, range?: unknown) => void;
    leave?: (event: MouseEvent | undefined, url: string, range?: unknown) => void;
};

export type TerminalLinkHandlerOptions = {
    onLinkActivated?: () => void;
};

interface UseTerminalLinkProps {
    onLoadPreview: (url: string, openPreview: boolean) => Promise<boolean>;
}

export function useTerminalLink({ onLoadPreview }: UseTerminalLinkProps) {
    const handleTerminalLinkOpen = useCallback((rawUrl: string, openInNewTab: boolean): boolean => {
        const normalized = normalizePreviewUrl(rawUrl);
        if (!normalized) return false;

        if (openInNewTab) {
            window.open(normalized, '_blank', 'noopener,noreferrer');
            return true;
        }

        void onLoadPreview(normalized, true);
        return true;
    }, [onLoadPreview]);

    const attachTerminalLinkHandler = useCallback((
        iframe: HTMLIFrameElement,
        cleanupRef: MutableRefObject<(() => void) | null>,
        options?: TerminalLinkHandlerOptions
    ) => {
        cleanupRef.current?.();
        const frameWindow = iframe.contentWindow as TerminalWindow | null;
        const terminal = frameWindow?.term;
        if (!frameWindow || !terminal) return;
        const notifyLinkActivated = options?.onLinkActivated;

        const restorers: Array<() => void> = [];

        const frameDocument = iframe.contentDocument;
        let lastModifierState = {
            metaKey: false,
            ctrlKey: false,
            at: 0,
        };

        if (frameDocument) {
            const recordModifierState = (event: MouseEvent) => {
                lastModifierState = {
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    at: Date.now(),
                };
            };

            frameDocument.addEventListener('mousedown', recordModifierState, true);
            frameDocument.addEventListener('click', recordModifierState, true);
            restorers.push(() => {
                frameDocument.removeEventListener('mousedown', recordModifierState, true);
                frameDocument.removeEventListener('click', recordModifierState, true);
            });
        }

        const originalOpen = frameWindow.open.bind(frameWindow);
        const patchedOpen: Window['open'] = (...args) => {
            const openWithModifier = Date.now() - lastModifierState.at < 1000;
            const shouldOpenInNewTab = openWithModifier && (lastModifierState.metaKey || lastModifierState.ctrlKey);

            if (typeof args[0] === 'string' && args[0].trim()) {
                notifyLinkActivated?.();
                const handled = handleTerminalLinkOpen(args[0], shouldOpenInNewTab);
                if (handled) {
                    return null;
                }
                return originalOpen(...args);
            }

            if (args.length === 0) {
                let fallbackWindow: Window | null = null;
                const syntheticWindow = {
                    opener: null,
                    location: {
                        set href(url: string) {
                            notifyLinkActivated?.();
                            const handled = handleTerminalLinkOpen(url, shouldOpenInNewTab);

                            if (!handled) {
                                fallbackWindow = originalOpen();
                                if (fallbackWindow) {
                                    try {
                                        fallbackWindow.opener = null;
                                    } catch {
                                        // Ignore opener assignment failures
                                    }
                                    fallbackWindow.location.href = url;
                                }
                            }
                        },
                        get href() {
                            return '';
                        },
                    },
                } as unknown as Window;

                return syntheticWindow;
            }

            return originalOpen(...args);
        };

        frameWindow.open = patchedOpen;
        restorers.push(() => {
            frameWindow.open = originalOpen;
        });

        const providers = terminal._core?._linkProviderService?.linkProviders;

        if (providers instanceof Map) {
            for (const provider of providers.values()) {
                if (!provider || typeof provider !== 'object') continue;

                if (typeof provider._handler === 'function') {
                    const originalHandler = provider._handler;
                    provider._handler = (event: MouseEvent | undefined, url: string) => {
                        notifyLinkActivated?.();
                        const shouldOpenInNewTab = Boolean(event?.metaKey || event?.ctrlKey);
                        const handled = handleTerminalLinkOpen(url, shouldOpenInNewTab);
                        if (!handled) {
                            originalHandler(event, url);
                        }
                    };

                    restorers.push(() => {
                        provider._handler = originalHandler;
                    });
                }

                if (typeof provider.provideLinks === 'function') {
                    const originalProvideLinks = provider.provideLinks.bind(provider);
                    provider.provideLinks = (line: number, callback: (links: TerminalLink[] | undefined) => void) => {
                        originalProvideLinks(line, (links: TerminalLink[] | undefined) => {
                            if (Array.isArray(links)) {
                                for (const link of links) {
                                    if (!link || typeof link !== 'object') continue;
                                    if (typeof link.activate !== 'function') continue;

                                    const originalActivate = link.activate.bind(link);
                                    link.activate = (event: MouseEvent | undefined, text: string) => {
                                        notifyLinkActivated?.();
                                        const shouldOpenInNewTab = Boolean(event?.metaKey || event?.ctrlKey);
                                        const handled = handleTerminalLinkOpen(text, shouldOpenInNewTab);
                                        if (!handled) {
                                            originalActivate(event, text);
                                        }
                                    };
                                }
                            }
                            callback(links);
                        });
                    };

                    restorers.push(() => {
                        provider.provideLinks = originalProvideLinks;
                    });
                }
            }
        }

        const existingLinkHandler = terminal.options.linkHandler;
        const nextLinkHandler: TerminalLinkHandler = {
            allowNonHttpProtocols: existingLinkHandler?.allowNonHttpProtocols ?? false,
            activate: (event, url, range) => {
                notifyLinkActivated?.();
                const shouldOpenInNewTab = Boolean(event?.metaKey || event?.ctrlKey);
                const handled = handleTerminalLinkOpen(url, shouldOpenInNewTab);
                if (!handled) {
                    existingLinkHandler?.activate?.(event, url, range);
                }
            },
            hover: (event, url, range) => {
                existingLinkHandler?.hover?.(event, url, range);
            },
            leave: (event, url, range) => {
                existingLinkHandler?.leave?.(event, url, range);
            },
        };

        terminal.options.linkHandler = nextLinkHandler;
        restorers.push(() => {
            terminal.options.linkHandler = existingLinkHandler ?? null;
        });

        cleanupRef.current = () => {
            for (const restore of restorers) {
                restore();
            }
            cleanupRef.current = null;
        };
    }, [handleTerminalLinkOpen]);

    return { handleTerminalLinkOpen, attachTerminalLinkHandler };
}
