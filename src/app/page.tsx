import Image from 'next/image';
import HomeDashboardContainer from '@/components/HomeDashboardContainer';
import { isAuth0Configured } from '@/lib/auth0';

export default function Home() {
  return (
    <div className="min-h-screen bg-[#f6f6f8] text-slate-950 transition-colors dark:bg-[#0d1117] dark:text-white">
      <a
        href="https://github.com/m0o0scar/palx"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open Palx GitHub repository"
        className="fixed top-0 right-0 z-50 h-20 w-20 cursor-pointer border-l border-b border-gray-400 bg-gray-300/95 shadow-sm backdrop-blur-sm transition-colors hover:bg-gray-500/95 dark:border-slate-700 dark:bg-slate-900/95 dark:hover:bg-slate-800/95"
        style={{ clipPath: 'polygon(100% 0, 0 0, 100% 100%)' }}
      >
        <span className="absolute left-[67%] top-[33%] -translate-x-1/2 -translate-y-1/2">
          <Image
            src="/github.png"
            alt="GitHub"
            width={22}
            height={22}
            priority
            className="rotate-45"
          />
        </span>
      </a>
      <main className="relative z-10 flex min-h-screen flex-col items-center justify-start p-4 transition-colors md:p-6">
        <HomeDashboardContainer showLogout logoutEnabled={isAuth0Configured} />
      </main>
    </div>
  );
}
