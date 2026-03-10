import Image from 'next/image';
import DismissibleAuthWarning from '@/components/DismissibleAuthWarning';
import GitRepoSelector from '@/components/GitRepoSelector';
import { isAuth0Configured, missingAuth0EnvVars } from '@/lib/auth0';

export default function Home() {
  const authWarning = !isAuth0Configured
    ? `Authentication is disabled because required Auth0 credentials are missing (${missingAuth0EnvVars.join(', ')}). This app is not protected and anybody with local/network access to this URL can use it.`
    : null;

  return (
    <>
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
        <DismissibleAuthWarning warning={authWarning} />
        <GitRepoSelector
          mode="home"
          showLogout
          logoutEnabled={isAuth0Configured}
        />
      </main>
    </>
  );
}
