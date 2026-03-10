import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { auth0, isAuth0Configured } from '@/lib/auth0';

const PUBLIC_FILE_PATH_PATTERN = /\.[^/]+$/;

function buildReturnTo(request: NextRequest): string {
  const { pathname, search } = request.nextUrl;
  return `${pathname}${search}`;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_FILE_PATH_PATTERN.test(pathname)) {
    return NextResponse.next();
  }

  if (!isAuth0Configured || !auth0) {
    return NextResponse.next();
  }

  const authResponse = await auth0.middleware(request);

  const isAuthRoute = pathname === '/auth' || pathname.startsWith('/auth/');

  if (isAuthRoute) {
    return authResponse;
  }

  const session = await auth0.getSession(request);
  if (session) {
    return authResponse;
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const loginUrl = new URL('/auth/login', request.url);
  loginUrl.searchParams.set('returnTo', buildReturnTo(request));
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.[^/]+$).*)',
  ],
};
