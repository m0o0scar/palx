import { Sidebar } from '@/components/layout/sidebar';
import { Suspense } from 'react';
import { WorkspaceRepoOpenTracker } from '@/components/workspace-repo-open-tracker';
import { getSettings } from '@/lib/store';

export default function WorkspaceLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const sidebarCollapsed = getSettings().sidebarCollapsed ?? false;

    return (
        <div className="flex h-screen gap-2 bg-slate-100/80 p-2 dark:bg-[#22272e] sm:p-3">
            <Suspense fallback={null}>
                <WorkspaceRepoOpenTracker />
            </Suspense>
            <Suspense fallback={<div className={`${sidebarCollapsed ? 'w-16' : 'w-64'} overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#22272e] flex items-center justify-center`}><span className="loading loading-spinner"></span></div>}>
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-[#22272e]">
                    <Sidebar initialCollapsed={sidebarCollapsed} className="border-r-0 bg-transparent min-h-full" />
                </div>
            </Suspense>
            <main className="flex-1 min-w-0 overflow-auto">
                {children}
            </main>
        </div>
    );
}
