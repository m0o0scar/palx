import { cn } from '@/lib/utils';
import { VisibilityMap } from './branch-tree-utils';
import { VisibilityToggle } from './visibility-toggle';

export function GroupHeader({
  name,
  groupPath,
  icon,
  actions,
  isExpanded,
  onToggle,
  visibilityMap,
  onToggleVisibility,
  depth = 0,
}: {
  name: string;
  groupPath: string;
  icon: React.ReactNode;
  actions?: React.ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  visibilityMap: VisibilityMap;
  onToggleVisibility: (path: string, type: 'visible' | 'hidden') => void;
  depth?: number;
}) {
  const directVisibility = visibilityMap[groupPath];
  // Check parent group visibility for inheritance
  const parentGroupPath = groupPath.includes('/') 
    ? groupPath.split('/').slice(0, -1).join('/') 
    : undefined;
  const parentVisibility = parentGroupPath ? visibilityMap[parentGroupPath] : null;
  const effectiveVisibility = directVisibility || parentVisibility;
  const isInherited = !directVisibility && parentVisibility !== null;
  
  return (
    <div
      className={cn(
        "group flex items-center gap-1 px-2 py-1.5 text-sm rounded-md cursor-pointer hover:bg-base-200 transition-colors font-medium",
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <div className="flex items-center gap-1.5 flex-1 min-w-0" onClick={onToggle}>
        <span className="text-xs opacity-70">{isExpanded ? '▼' : '▶'}</span>
        <span className="shrink-0">{icon}</span>
        <span className="truncate min-w-0 flex-1">{name}</span>
      </div>
      {actions}
      <div className="flex items-center gap-0.5 ml-auto">
        <VisibilityToggle
          type="visible"
          isActive={directVisibility === 'visible' || (isInherited && effectiveVisibility === 'visible')}
          isInherited={isInherited && effectiveVisibility === 'visible'}
          onClick={(e) => { e.stopPropagation(); onToggleVisibility(groupPath, 'visible'); }}
          showOnHover={directVisibility === 'visible' || (isInherited && effectiveVisibility === 'visible')}
        />
        <VisibilityToggle
          type="hidden"
          isActive={directVisibility === 'hidden' || (isInherited && effectiveVisibility === 'hidden')}
          isInherited={isInherited && effectiveVisibility === 'hidden'}
          onClick={(e) => { e.stopPropagation(); onToggleVisibility(groupPath, 'hidden'); }}
          showOnHover={directVisibility === 'hidden' || (isInherited && effectiveVisibility === 'hidden')}
        />
      </div>
    </div>
  );
}
