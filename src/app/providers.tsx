'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, useState } from 'react';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/toaster';
import { CommandPalette } from '@/components/command-palette';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
        {children}
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
