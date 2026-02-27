import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizePreviewUrl } from './url.ts';

describe('normalizePreviewUrl', () => {
    it('should return null for empty string', () => {
        assert.strictEqual(normalizePreviewUrl(''), null);
        assert.strictEqual(normalizePreviewUrl('   '), null);
    });

    it('should return null for non-http protocols', () => {
        assert.strictEqual(normalizePreviewUrl('ftp://example.com'), null);
        assert.strictEqual(normalizePreviewUrl('mailto:user@example.com'), null);
        assert.strictEqual(normalizePreviewUrl('javascript:alert(1)'), null);
        assert.strictEqual(normalizePreviewUrl('custom-scheme:abc'), null);
    });

    it('should return the original URL if it starts with http:// or https://', () => {
        assert.strictEqual(normalizePreviewUrl('http://example.com'), 'http://example.com');
        assert.strictEqual(normalizePreviewUrl('https://example.com'), 'https://example.com');
        assert.strictEqual(normalizePreviewUrl('  https://example.com  '), 'https://example.com');
    });

    it('should prepend https:// for non-local hosts when protocol is missing', () => {
        assert.strictEqual(normalizePreviewUrl('example.com'), 'https://example.com');
        assert.strictEqual(normalizePreviewUrl('example.com/docs'), 'https://example.com/docs');
    });

    it('should prepend http:// for localhost and loopback hosts when protocol is missing', () => {
        assert.strictEqual(normalizePreviewUrl('localhost:3000'), 'http://localhost:3000');
        assert.strictEqual(normalizePreviewUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080');
    });
});
