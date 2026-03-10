'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

type DismissibleAuthWarningProps = {
  warning: string | null;
};

export default function DismissibleAuthWarning({
  warning,
}: DismissibleAuthWarningProps) {
  const [dismissed, setDismissed] = useState(false);

  if (!warning || dismissed) {
    return null;
  }

  return (
    <div
      className="mb-4 flex w-full max-w-5xl items-start gap-3 rounded-xl border border-amber-300 bg-amber-100/90 px-4 py-3 text-sm text-amber-900 shadow-sm dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-100"
      role="alert"
    >
      <p className="min-w-0 flex-1">{warning}</p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss authentication warning"
        className="shrink-0 rounded-md p-1 text-amber-700 transition hover:bg-amber-200/70 hover:text-amber-900 focus:outline-none focus:ring-2 focus:ring-amber-500/60 dark:text-amber-100 dark:hover:bg-amber-400/15"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
