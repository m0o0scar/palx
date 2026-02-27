export const normalizePreviewUrl = (rawValue: string): string | null => {
    const trimmed = rawValue.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;
    if (/^(mailto|javascript|data|tel):/i.test(trimmed)) return null;

    const firstSegment = trimmed.split('/')[0] ?? '';
    const colonIndex = firstSegment.indexOf(':');
    if (colonIndex > 0 && !firstSegment.startsWith('[')) {
        const hostCandidate = firstSegment.slice(0, colonIndex).toLowerCase();
        const trailing = firstSegment.slice(colonIndex + 1);
        const isLikelyHostWithPort = hostCandidate.includes('.')
            || hostCandidate === 'localhost'
            || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostCandidate)
            || /^\d+$/.test(trailing);
        if (!isLikelyHostWithPort) return null;
    }

    const hostPort = firstSegment.includes('@') ? firstSegment.slice(firstSegment.lastIndexOf('@') + 1) : firstSegment;
    const host = hostPort.startsWith('[')
        ? hostPort.slice(1, Math.max(1, hostPort.indexOf(']'))).toLowerCase()
        : hostPort.split(':')[0].toLowerCase();

    const protocol = host === 'localhost' || host === '127.0.0.1' || host === '::1'
        ? 'http'
        : 'https';
    return `${protocol}://${trimmed}`;
};
