import fs from 'fs/promises';
import path from 'path';
import { NextRequest } from 'next/server';

const IMAGE_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');
  if (!filePath || !path.isAbsolute(filePath)) {
    return new Response('Invalid path', { status: 400 });
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = IMAGE_TYPES[extension];
  if (!contentType) {
    return new Response('Unsupported file type', { status: 415 });
  }

  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return new Response('Not found', { status: 404 });
    }

    const etag = `W/"${stats.size}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
    const lastModified = stats.mtime.toUTCString();
    const cacheHeaders = {
      'Cache-Control': 'private, max-age=60',
      ETag: etag,
      'Last-Modified': lastModified,
    };
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: cacheHeaders,
      });
    }

    const fileBuffer = await fs.readFile(filePath);
    return new Response(fileBuffer, {
      headers: {
        'Content-Type': contentType,
        ...cacheHeaders,
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
