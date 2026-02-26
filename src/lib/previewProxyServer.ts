import http, { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';

const PROXY_HOST = '127.0.0.1';
const PICKER_SCRIPT_PATH = '/__viba_preview_picker.js';
const PICKER_SCRIPT_VERSION = '4';

const PICKER_CLIENT_SCRIPT_TEMPLATE = String.raw`(() => {
  if (window.__vibaPreviewPickerInstalled) {
    return;
  }

  window.__vibaPreviewPickerInstalled = true;

  const TARGET_ORIGIN = __VIBA_TARGET_ORIGIN__;
  const OVERLAY_ID = '__viba_preview_picker_overlay__';
  let pickerActive = false;

  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }

    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  };

  const getOverlay = () => {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      overlay.style.position = 'fixed';
      overlay.style.zIndex = '2147483647';
      overlay.style.pointerEvents = 'none';
      overlay.style.border = '2px solid #22c55e';
      overlay.style.background = 'rgba(34, 197, 94, 0.12)';
      overlay.style.boxSizing = 'border-box';
      overlay.style.display = 'none';
      document.documentElement.appendChild(overlay);
    }

    return overlay;
  };

  const clearOverlay = () => {
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.style.display = 'none';
    }
  };

  const getElementFromTarget = (target) => {
    if (target instanceof Element) {
      return target;
    }

    if (target && target.parentElement instanceof Element) {
      return target.parentElement;
    }

    return null;
  };

  const getAnchorFromTarget = (target) => {
    const element = getElementFromTarget(target);
    if (!element) {
      return null;
    }

    if (element instanceof HTMLAnchorElement) {
      return element;
    }

    return element.closest('a[href]');
  };

  const resolveHttpUrl = (value) => {
    try {
      const parsed = new URL(value, window.location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      return parsed.toString();
    } catch {
      return null;
    }
  };

  const buildSelector = (element) => {
    const parts = [];
    let node = element;

    for (let depth = 0; node && depth < 7; depth += 1) {
      let segment = node.tagName.toLowerCase();

      if (node.id) {
        segment += '#' + cssEscape(node.id);
        parts.unshift(segment);
        break;
      }

      const classNames = Array.from(node.classList || []).slice(0, 3);
      if (classNames.length > 0) {
        segment += '.' + classNames.map((name) => cssEscape(name)).join('.');
      }

      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) {
          segment += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      }

      parts.unshift(segment);
      node = parent;
    }

    return parts.join(' > ');
  };

  const getReactFiberNode = (element) => {
    let current = element;
    while (current) {
      const keys = Object.getOwnPropertyNames(current);
      for (const key of keys) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          const node = current[key];
          if (node) {
            return node;
          }
        }
      }
      current = current.parentElement;
    }

    return null;
  };

  const readComponentName = (candidate) => {
    if (!candidate) {
      return null;
    }

    if (typeof candidate === 'function') {
      return candidate.displayName || candidate.name || null;
    }

    if (typeof candidate !== 'object') {
      return null;
    }

    if (typeof candidate.displayName === 'string' && candidate.displayName) {
      return candidate.displayName;
    }

    if (typeof candidate.render === 'function') {
      return candidate.render.displayName || candidate.render.name || null;
    }

    if (typeof candidate.type === 'function') {
      return candidate.type.displayName || candidate.type.name || null;
    }

    return null;
  };

  const normalizeComponentName = (name) => {
    if (!name) {
      return name;
    }

    const memoMatch = name.match(/^Memo\((.+)\)$/);
    if (memoMatch && memoMatch[1]) {
      return memoMatch[1];
    }

    const forwardRefMatch = name.match(/^ForwardRef\((.+)\)$/);
    if (forwardRefMatch && forwardRefMatch[1]) {
      return forwardRefMatch[1];
    }

    return name;
  };

  const getUserComponentStack = (element) => {
    let fiberNode = getReactFiberNode(element);
    if (!fiberNode) {
      return [];
    }

    const userStack = [];

    const internalNames = new Set([
      'Suspense', 'ErrorBoundary', 'Router', 'AppRouter', 'LayoutRouter',
      'RenderFromTemplateContext', 'ScrollAndFocusHandler', 'InnerLayoutRouter',
      'RedirectErrorBoundary', 'NotFoundBoundary', 'LoadingBoundary',
      'ReactDevOverlay', 'HotReload', 'AppContainer', 'Route', 'Link', 'Image',
      'OuterLayoutRouter', 'Head', 'StringRefs',
    ]);

    while (fiberNode) {
      if (typeof fiberNode.elementType === 'string' || typeof fiberNode.type === 'string') {
        fiberNode = fiberNode.return;
        continue;
      }

      let componentName = readComponentName(fiberNode.elementType) || readComponentName(fiberNode.type);
      componentName = normalizeComponentName(componentName);

      if (!componentName) {
        fiberNode = fiberNode.return;
        continue;
      }

      if (
        internalNames.has(componentName) ||
        componentName.includes('Context') ||
        componentName.includes('Provider') ||
        componentName.startsWith('ForwardRef') ||
        componentName.startsWith('Memo')
      ) {
        fiberNode = fiberNode.return;
        continue;
      }

      let sourceData = null;
      let isThirdParty = false;

      if (fiberNode._debugSource) {
        sourceData = {
          fileName: fiberNode._debugSource.fileName,
          lineNumber: fiberNode._debugSource.lineNumber,
          columnNumber: fiberNode._debugSource.columnNumber,
        };

        if (sourceData.fileName.includes('node_modules')) {
          isThirdParty = true;
        }
      }

      if (isThirdParty) {
        fiberNode = fiberNode.return;
        continue;
      }

      userStack.push({
        name: componentName,
        source: sourceData,
      });

      fiberNode = fiberNode.return;
    }

    return userStack;
  };

  const postPickerState = () => {
    window.parent.postMessage({
      type: 'viba:preview-picker-state',
      active: pickerActive,
    }, '*');
  };

  const toTargetUrl = (value) => {
    if (!TARGET_ORIGIN || typeof TARGET_ORIGIN !== 'string') {
      return value;
    }

    try {
      const parsed = new URL(value, window.location.href);
      const targetOrigin = new URL(TARGET_ORIGIN);

      if (parsed.origin !== window.location.origin) {
        return parsed.toString();
      }

      parsed.protocol = targetOrigin.protocol;
      parsed.host = targetOrigin.host;
      return parsed.toString();
    } catch {
      return value;
    }
  };

  const postLocationChange = () => {
    window.parent.postMessage({
      type: 'viba:preview-location-change',
      url: toTargetUrl(window.location.href),
    }, '*');
  };

  const highlight = (element) => {
    const overlay = getOverlay();
    const rect = element.getBoundingClientRect();

    if (rect.width === 0 && rect.height === 0) {
      overlay.style.display = 'none';
      return;
    }

    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  };

  const selectElement = (element) => {
    const rect = element.getBoundingClientRect();
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const reactComponentStack = getUserComponentStack(element);

    window.parent.postMessage({
      type: 'viba:preview-element-selected',
      element: {
        selector: buildSelector(element),
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        className: element.className || null,
        text,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        reactComponentStack,
      },
    }, '*');
  };

  const setPickerActive = (active) => {
    pickerActive = active;
    document.documentElement.style.cursor = active ? 'crosshair' : '';

    if (!active) {
      clearOverlay();
    }

    postPickerState();
  };

  const handleMouseMove = (event) => {
    if (!pickerActive) {
      return;
    }

    const element = getElementFromTarget(event.target);
    if (!element) {
      clearOverlay();
      return;
    }

    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay && (element === overlay || overlay.contains(element))) {
      return;
    }

    highlight(element);
  };

  const handleClick = (event) => {
    if (!pickerActive) {
      const anchor = getAnchorFromTarget(event.target);
      if (!anchor || event.defaultPrevented) {
        return;
      }

      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }

      const resolvedUrl = resolveHttpUrl(anchor.href);
      if (!resolvedUrl) {
        return;
      }

      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }

        window.parent.postMessage({
          type: 'viba:preview-link-open',
          url: toTargetUrl(resolvedUrl),
        }, '*');
        return;
      }

      const anchorTarget = (anchor.getAttribute('target') || '').trim().toLowerCase();
      if (anchorTarget === '_blank') {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }

        window.location.assign(resolvedUrl);
      }
      return;
    }

    const element = getElementFromTarget(event.target);
    if (!element) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }

    selectElement(element);
    setPickerActive(false);
  };

  const handleKeyDown = (event) => {
    if (!pickerActive) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setPickerActive(false);
    }
  };

  const handleMessage = (event) => {
    const payload = event.data;
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (payload.type === 'viba:preview-picker-toggle') {
      setPickerActive(Boolean(payload.active));
      return;
    }

    if (payload.type === 'viba:preview-navigation') {
      if (payload.action === 'back') {
        window.history.back();
        return;
      }

      if (payload.action === 'forward') {
        window.history.forward();
        return;
      }

      if (payload.action === 'reload') {
        window.location.reload();
      }
      return;
    }

    if (payload.type === 'viba:preview-location-request') {
      postLocationChange();
    }
  };

  const wrapHistoryMethod = (methodName) => {
    const originalMethod = window.history[methodName];
    if (typeof originalMethod !== 'function') {
      return;
    }

    window.history[methodName] = function (...args) {
      const result = originalMethod.apply(window.history, args);
      postLocationChange();
      return result;
    };
  };

  wrapHistoryMethod('pushState');
  wrapHistoryMethod('replaceState');

  document.addEventListener('mousemove', handleMouseMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('message', handleMessage);
  window.addEventListener('popstate', postLocationChange);
  window.addEventListener('hashchange', postLocationChange);

  postLocationChange();
  window.parent.postMessage({ type: 'viba:preview-picker-ready' }, '*');
})();`;

const buildPickerClientScript = (targetOrigin: string): string => (
  PICKER_CLIENT_SCRIPT_TEMPLATE.replace('__VIBA_TARGET_ORIGIN__', JSON.stringify(targetOrigin))
);

type PreviewProxyState = {
  middleware: ReturnType<typeof createProxyMiddleware<IncomingMessage, ServerResponse>>;
  port: number;
  server: http.Server;
  targetOrigin: string;
};

declare global {
  var __vibaPreviewProxyState: PreviewProxyState | undefined;
  var __vibaPreviewProxyStates: Map<string, PreviewProxyState> | undefined;
  var __vibaPreviewProxyPromises: Map<string, Promise<PreviewProxyState>> | undefined;
}

const injectPickerScript = (html: string): string => {
  if (html.includes(PICKER_SCRIPT_PATH)) {
    return html;
  }

  const scriptTag = `<script src="${PICKER_SCRIPT_PATH}?v=${PICKER_SCRIPT_VERSION}"></script>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${scriptTag}</body>`);
  }

  return `${html}${scriptTag}`;
};

const normalizeTargetUrl = (target: string): URL => {
  const parsed = new URL(target);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https preview URLs are supported');
  }

  return parsed;
};

const getPreviewProxyStateMap = (): Map<string, PreviewProxyState> => {
  if (!globalThis.__vibaPreviewProxyStates) {
    globalThis.__vibaPreviewProxyStates = new Map<string, PreviewProxyState>();
  }

  // Backward compatibility for hot-reload transitions from a single-state runtime.
  if (globalThis.__vibaPreviewProxyState) {
    const legacyState = globalThis.__vibaPreviewProxyState;
    globalThis.__vibaPreviewProxyStates.set(legacyState.targetOrigin, legacyState);
    globalThis.__vibaPreviewProxyState = undefined;
  }

  return globalThis.__vibaPreviewProxyStates;
};

const getPreviewProxyPromiseMap = (): Map<string, Promise<PreviewProxyState>> => {
  if (!globalThis.__vibaPreviewProxyPromises) {
    globalThis.__vibaPreviewProxyPromises = new Map<string, Promise<PreviewProxyState>>();
  }

  return globalThis.__vibaPreviewProxyPromises;
};

const createPreviewProxyServer = async (targetOrigin: string): Promise<PreviewProxyState> => {
  const middleware = createProxyMiddleware<IncomingMessage, ServerResponse>({
    changeOrigin: true,
    // Preserve original client-facing host/proto metadata for frameworks
    // (e.g. Next.js Server Actions CSRF checks) running behind this proxy.
    xfwd: true,
    selfHandleResponse: true,
    secure: false,
    target: targetOrigin,
    ws: true,
    on: {
      proxyReq: (proxyReq, request) => {
        const host = request.headers.host;
        if (host) {
          proxyReq.setHeader('x-forwarded-host', host);
          const forwardedPort = host.includes(':') ? host.split(':').at(-1) : undefined;
          if (forwardedPort) {
            proxyReq.setHeader('x-forwarded-port', forwardedPort);
          }
        }

        if (!proxyReq.getHeader('x-forwarded-proto')) {
          proxyReq.setHeader('x-forwarded-proto', 'http');
        }
      },
      proxyRes: responseInterceptor(async (responseBuffer, proxyRes) => {
        const rawContentType = proxyRes.headers['content-type'];
        const contentType = Array.isArray(rawContentType)
          ? rawContentType.join(';')
          : rawContentType || '';

        if (!contentType.toLowerCase().includes('text/html')) {
          return responseBuffer;
        }

        return injectPickerScript(responseBuffer.toString('utf8'));
      }),
      error: (error, _request, response) => {
        if (response instanceof ServerResponse) {
          if (!response.headersSent) {
            response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          }
          response.end(`Preview proxy error: ${error.message}`);
        }
      },
    },
  });

  const server = http.createServer((request, response) => {
    if (request.url === PICKER_SCRIPT_PATH || request.url?.startsWith(`${PICKER_SCRIPT_PATH}?`)) {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/javascript; charset=utf-8',
      });
      response.end(buildPickerClientScript(targetOrigin));
      return;
    }

    middleware(request, response, (error) => {
      if (error) {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        response.end(`Preview proxy error: ${String(error)}`);
        return;
      }

      if (!response.headersSent) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end('Preview route not found');
    });
  });

  server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const upgrade = (middleware as { upgrade?: (req: IncomingMessage, socket: Socket, head: Buffer) => void }).upgrade;

    if (!upgrade) {
      socket.destroy();
      return;
    }

    upgrade(request, socket, head);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, PROXY_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Preview proxy failed to bind to a TCP port'));
        return;
      }

      resolve(address.port);
    });
  });

  return {
    middleware,
    port,
    server,
    targetOrigin,
  };
};

export const ensurePreviewProxyServer = async (target: string): Promise<{ proxyBaseUrl: string }> => {
  const normalizedTarget = normalizeTargetUrl(target);
  const targetOrigin = normalizedTarget.origin;
  const states = getPreviewProxyStateMap();
  const pendingCreates = getPreviewProxyPromiseMap();

  const activeState = states.get(targetOrigin);
  if (activeState && activeState.server.listening) {
    return { proxyBaseUrl: `http://${PROXY_HOST}:${activeState.port}` };
  }

  if (activeState && !activeState.server.listening) {
    states.delete(targetOrigin);
  }

  const pending = pendingCreates.get(targetOrigin);
  if (pending) {
    const state = await pending;
    return { proxyBaseUrl: `http://${PROXY_HOST}:${state.port}` };
  }

  let createPromise: Promise<PreviewProxyState>;
  createPromise = createPreviewProxyServer(targetOrigin)
    .then((state) => {
      states.set(targetOrigin, state);
      state.server.once('close', () => {
        const existing = states.get(targetOrigin);
        if (existing === state) {
          states.delete(targetOrigin);
        }
      });
      return state;
    })
    .finally(() => {
      const existingPending = pendingCreates.get(targetOrigin);
      if (existingPending === createPromise) {
        pendingCreates.delete(targetOrigin);
      }
    });

  pendingCreates.set(targetOrigin, createPromise);
  const nextState = await createPromise;
  return { proxyBaseUrl: `http://${PROXY_HOST}:${nextState.port}` };
};

export const buildPreviewProxyUrl = (proxyBaseUrl: string, target: string): string => {
  const targetUrl = normalizeTargetUrl(target);
  const proxyUrl = new URL(proxyBaseUrl);

  proxyUrl.pathname = targetUrl.pathname || '/';
  proxyUrl.search = targetUrl.search;
  proxyUrl.hash = targetUrl.hash;

  return proxyUrl.toString();
};
