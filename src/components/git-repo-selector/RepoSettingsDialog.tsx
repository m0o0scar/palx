import { useState } from 'react';
import { ImagePlus, Trash2, X } from 'lucide-react';
import SessionFileBrowser from '@/components/SessionFileBrowser';

export type RepoSettingsDialogProps = {
  isOpen: boolean;
  projectForSettings: string | null;
  projectAlias: string;
  projectStartupCommand: string;
  projectDevServerCommand: string;
  defaultProjectStartupCommand: string;
  defaultProjectDevServerCommand: string;
  projectIconPath: string | null;
  isSavingProjectSettings: boolean;
  isUploadingProjectIcon: boolean;
  projectSettingsError: string | null;
  onAliasChange: (value: string) => void;
  onStartupCommandChange: (value: string) => void;
  onDevServerCommandChange: (value: string) => void;
  onUploadIcon: (iconPath: string) => void;
  onRemoveIcon: () => void;
  onClose: () => void;
  onSave: () => void;
};

export function RepoSettingsDialog({
  isOpen,
  projectForSettings,
  projectAlias,
  projectStartupCommand,
  projectDevServerCommand,
  defaultProjectStartupCommand,
  defaultProjectDevServerCommand,
  projectIconPath,
  isSavingProjectSettings,
  isUploadingProjectIcon,
  projectSettingsError,
  onAliasChange,
  onStartupCommandChange,
  onDevServerCommandChange,
  onUploadIcon,
  onRemoveIcon,
  onClose,
  onSave,
}: RepoSettingsDialogProps) {
  const [isIconBrowserOpen, setIsIconBrowserOpen] = useState(false);

  if (!isOpen || !projectForSettings) return null;

  const iconPreviewUrl = projectIconPath
    ? `/api/file-thumbnail?path=${encodeURIComponent(projectIconPath)}`
    : null;

  return (
    <div className="fixed inset-0 z-[1002] flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#151b26]">
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-5 py-4 md:px-6 dark:border-white/10 dark:bg-[#1e2532]/75">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Project Settings</h3>
          <button
            className="btn btn-circle btn-ghost btn-sm text-slate-500 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
            onClick={onClose}
            disabled={isSavingProjectSettings || isUploadingProjectIcon}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5 md:p-6">
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Project</label>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 break-all font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200">
              {projectForSettings}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Alias</label>
            <input
              className="input w-full border-slate-200 bg-slate-50 text-sm text-slate-800 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
              value={projectAlias}
              onChange={(event) => onAliasChange(event.target.value)}
              placeholder="Optional display name for this project"
              disabled={isSavingProjectSettings || isUploadingProjectIcon}
            />
          </div>

          <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Project Icon</label>
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-[#1e2532]">
                {iconPreviewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={iconPreviewUrl} alt="Project icon" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-[10px] text-slate-500">No Icon</span>
                )}
              </div>
              <button
                type="button"
                className="btn btn-sm gap-2"
                disabled={isUploadingProjectIcon || isSavingProjectSettings}
                onClick={() => setIsIconBrowserOpen(true)}
              >
                <ImagePlus className="h-4 w-4" />
                Choose Icon
              </button>
              {projectIconPath && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm gap-2 text-red-600"
                  disabled={isUploadingProjectIcon || isSavingProjectSettings}
                  onClick={onRemoveIcon}
                >
                  <Trash2 className="h-4 w-4" />
                  Remove
                </button>
              )}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Supported: png, jpg, jpeg, webp, svg, ico. Max 2MB.
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Start Up Command</label>
            <textarea
              className="textarea w-full border-slate-200 bg-slate-50 font-mono text-sm text-slate-800 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
              rows={3}
              value={projectStartupCommand}
              onChange={(event) => onStartupCommandChange(event.target.value)}
              placeholder={defaultProjectStartupCommand}
              disabled={isSavingProjectSettings || isUploadingProjectIcon}
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Multi-line commands are supported.
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Dev Server Command</label>
            <textarea
              className="textarea w-full border-slate-200 bg-slate-50 font-mono text-sm text-slate-800 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
              rows={3}
              value={projectDevServerCommand}
              onChange={(event) => onDevServerCommandChange(event.target.value)}
              placeholder={defaultProjectDevServerCommand}
              disabled={isSavingProjectSettings || isUploadingProjectIcon}
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Multi-line commands are supported.
            </div>
          </div>

          {(isUploadingProjectIcon || isSavingProjectSettings) && (
            <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <span className="loading loading-spinner loading-xs"></span>
              {isUploadingProjectIcon ? 'Uploading icon...' : 'Saving project settings...'}
            </div>
          )}

          {projectSettingsError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {projectSettingsError}
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-white/10">
            <button
              className="btn btn-ghost text-slate-700 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
              onClick={onClose}
              disabled={isSavingProjectSettings || isUploadingProjectIcon}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={onSave}
              disabled={isSavingProjectSettings || isUploadingProjectIcon}
            >
              Save
            </button>
          </div>
        </div>
      </div>

      {isIconBrowserOpen && (
        <SessionFileBrowser
          title="Choose Project Icon"
          initialPath={projectForSettings}
          onConfirm={async (paths) => {
            const selectedPath = paths[0];
            if (!selectedPath) return;
            onUploadIcon(selectedPath);
            setIsIconBrowserOpen(false);
          }}
          onCancel={() => setIsIconBrowserOpen(false)}
          confirmLabel="Use Selected Icon"
          defaultViewMode="grid"
          viewModeStorageKey={null}
          selectionMode="single"
          allowedFileExtensions={['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico']}
          zIndexClassName="z-[1003]"
        />
      )}
    </div>
  );
}
