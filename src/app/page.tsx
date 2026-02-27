'use client';

import Image from "next/image";
import GitRepoSelector from "@/components/GitRepoSelector";

export default function Home() {
  return (
    <>
      <a
        href="https://github.com/m0o0scar/viba"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open Viba GitHub repository"
        className="fixed top-0 right-0 z-50 h-20 w-20 cursor-pointer border-l border-b border-gray-400 bg-gray-300/95 shadow-sm backdrop-blur-sm transition-colors hover:bg-gray-500/95 dark:border-slate-700 dark:bg-slate-900/95 dark:hover:bg-slate-800/95"
        style={{ clipPath: "polygon(100% 0, 0 0, 100% 100%)" }}
      >
        <span className="absolute left-[67%] top-[33%] -translate-x-1/2 -translate-y-1/2">
          <Image src="/github.png" alt="GitHub" width={22} height={22} priority className="rotate-45" />
        </span>
      </a>
      <main className="flex min-h-screen flex-col items-center justify-start bg-[radial-gradient(circle_at_top_left,_#e0e7ff,_#f5f7fb_55%)] p-4 transition-colors md:p-6 dark:bg-[radial-gradient(circle_at_top_left,_#1b2234,_#0b0e14_55%)]">
        <GitRepoSelector mode="home" />
      </main>
    </>
  );
}
