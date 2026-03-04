'use client';

import { useMemo, useRef, useState, useImperativeHandle, forwardRef, useEffect, useCallback } from 'react';
import { Commit, BranchTrackingInfo } from '@/lib/types';
import { generateGraphData } from '@/lib/graph-utils';
import { cn } from '@/lib/utils';
import { ContextMenu, ContextMenuItem } from '@/components/context-menu';
import { getBranchTagColors } from '@/lib/branch-colors';
import { SessionAssociationDot } from './session-association-dot';


const ROW_HEIGHT = 24; // Compact rows like Fork
const LANE_WIDTH = 12;
const DOT_SIZE = 3;
const STROKE_WIDTH = 2;

// Helper function to highlight matching text
function HighlightedText({ text, searchQuery }: { text: string; searchQuery: string }) {
    if (!searchQuery || !text) return <>{text}</>;
    
    const query = searchQuery.toLowerCase();
    const lowerText = text.toLowerCase();
    const parts: { text: string; highlighted: boolean }[] = [];
    
    let lastIndex = 0;
    let index = lowerText.indexOf(query);
    
    while (index !== -1) {
        // Add non-matching part
        if (index > lastIndex) {
            parts.push({ text: text.slice(lastIndex, index), highlighted: false });
        }
        // Add matching part (preserve original case)
        parts.push({ text: text.slice(index, index + query.length), highlighted: true });
        lastIndex = index + query.length;
        index = lowerText.indexOf(query, lastIndex);
    }
    
    // Add remaining non-matching part
    if (lastIndex < text.length) {
        parts.push({ text: text.slice(lastIndex), highlighted: false });
    }
    
    if (parts.length === 0) return <>{text}</>;
    
    return (
        <>
            {parts.map((part, i) => 
                part.highlighted ? (
                    <mark key={i} className="bg-warning text-warning-content rounded-sm px-0.5">{part.text}</mark>
                ) : (
                    <span key={i}>{part.text}</span>
                )
            )}
        </>
    );
}

export interface GitGraphHandle {
    scrollToCommit: (hash: string) => boolean;
}

export const GitGraph = forwardRef<GitGraphHandle, {
    commits: Commit[],
    onSelectCommit?: (hash: string, modifiers?: { isMultiSelect: boolean; isRangeSelect: boolean }) => void,
    onResetToCommit?: (hash: string) => void,
    onRevertCommit?: (hash: string, message: string) => void,
    onCreateTag?: (hash: string) => void,
    onCherryPickCommit?: (hash: string, message: string) => void,
    onCherryPickSelectedCommits?: () => void,
    onRewordCommit?: (hash: string, subject: string, body: string, branch: string) => void,
    selectedHash?: string,
    selectedHashes?: Set<string>,
    onEndReached?: () => void,
    isLoadingMore?: boolean,
    currentBranch?: string,
    hiddenBranches?: Set<string>,
    localBranches?: string[],
    trackingInfo?: Record<string, BranchTrackingInfo>,
    getBranchTagContextMenuItems?: (displayRef: string) => ContextMenuItem[] | null,
    isBranchSessionAssociated?: (displayRef: string) => boolean
}>(function GitGraph({
    commits,
    onSelectCommit,
    onResetToCommit,
    onRevertCommit,
    onCreateTag,
    onCherryPickCommit,
    onCherryPickSelectedCommits,
    onRewordCommit,
    selectedHash,
    selectedHashes,
    onEndReached,
    isLoadingMore,
    currentBranch,
    hiddenBranches,
    localBranches = [],
    trackingInfo,
    getBranchTagContextMenuItems,
    isBranchSessionAssociated
}, ref) {
    const normalizeDecoratedRef = useCallback((ref: string) => {
        if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
        if (ref.startsWith('refs/remotes/')) return ref.slice('refs/remotes/'.length);
        if (ref.startsWith('remotes/')) return ref.slice('remotes/'.length);
        return ref;
    }, []);
    const getRefDisplayName = useCallback((ref: string) => {
        if (ref.startsWith('tag:')) return ref.replace(/^tag:\s*/, '').trim();
        return ref;
    }, []);

    const nodes = useMemo(
        () => generateGraphData(commits, { localBranches }),
        [commits, localBranches]
    );
    const scrollRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    
    // Search state
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    
    // Handle Cmd+F to open search
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Cmd+F (Mac) or Ctrl+F (Linux)
            if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
                e.preventDefault();
                setIsSearchOpen(true);
                // Focus input after render
                setTimeout(() => searchInputRef.current?.focus(), 0);
            }
            // Escape to close search
            if (e.key === 'Escape' && isSearchOpen) {
                setIsSearchOpen(false);
                setSearchQuery('');
            }
        };
        
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isSearchOpen]);
    
    const handleCloseSearch = useCallback(() => {
        setIsSearchOpen(false);
        setSearchQuery('');
    }, []);

    // Expose scrollToCommit function via ref
    useImperativeHandle(ref, () => ({
        scrollToCommit: (hash: string) => {
            if (!nodes || nodes.length === 0) return false;
            
            const index = nodes.findIndex(n => n.hash === hash);
            if (index === -1) return false;
            
            // Scroll to the commit row
            if (scrollRef.current) {
                const scrollTop = index * ROW_HEIGHT - (scrollRef.current.clientHeight / 2) + ROW_HEIGHT / 2;
                scrollRef.current.scrollTop = Math.max(0, scrollTop);
            }
            return true;
        }
    }), [nodes]);

    if (!nodes || nodes.length === 0) return null;

    // Calculate SVG dimensions
    const maxLane = Math.max(...nodes.map(n => n.x), 0);
    const width = (maxLane + 1) * LANE_WIDTH + 20;
    const height = nodes.length * ROW_HEIGHT;

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
        if (scrollHeight - scrollTop - clientHeight < 100) {
            onEndReached?.();
        }
    };

    return (
        <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-slate-900 font-mono text-sm select-none">
            {/* Search Input - Sticky on top */}
            {isSearchOpen && (
                <div className="sticky top-0 z-30 bg-white dark:bg-slate-900 border-b border-base-300 px-2 py-2 flex items-center gap-2">
                    <span className="opacity-50">🔍</span>
                    <input
                        ref={searchInputRef}
                        type="text"
                        placeholder="Search in commits..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="input input-bordered input-sm flex-1 text-sm"
                        autoFocus
                    />
                    <div className="tooltip tooltip-left z-50" data-tip="Close search (Esc)">
                        <button
                            onClick={handleCloseSearch}
                            className="btn btn-ghost btn-sm btn-square"
                        >
                            ✖️
                        </button>
                    </div>
                </div>
            )}
            
            <div className="flex-1 overflow-auto h-full max-w-full px-2" onScroll={handleScroll} ref={scrollRef}>
                <div className="relative min-w-full" style={{ height }}>
                    {/* SVG Graph Layout */}
                    <svg width={width} height={height} className="absolute top-0 left-0 pointer-events-none z-10">
                        {nodes.map((node) => (
                            <g key={node.hash}>
                                {/* Draw paths */}
                                {node.paths.map((path, i) => {
                                    const x1 = path.x1 * LANE_WIDTH + LANE_WIDTH / 2;
                                    const y1 = path.y1 * ROW_HEIGHT + ROW_HEIGHT / 2;
                                    const x2 = path.x2 * LANE_WIDTH + LANE_WIDTH / 2;
                                    const y2 = path.y2 * ROW_HEIGHT + ROW_HEIGHT / 2;

                                    let d = '';
                                    if (path.type === 'straight') {
                                        d = `M ${x1} ${y1} L ${x2} ${y2}`;
                                    } else {
                                        // Fork/Merge styled Bezier
                                        // Standard cubic bezier: ctrl points at mid-y
                                        const cy1 = y1 + ROW_HEIGHT * 0.5;
                                        const cy2 = y2 - ROW_HEIGHT * 0.5;
                                        d = `M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`;
                                    }

                                    return (
                                        <path
                                            key={i}
                                            d={d}
                                            stroke={path.color}
                                            strokeWidth={STROKE_WIDTH}
                                            fill="none"
                                            strokeLinecap="round"
                                        />
                                    )
                                })}
                            </g>
                        ))}

                        {/* Draw Nodes on top of all paths to avoid overlap ugliness */}
                        {nodes.map((node) => (
                            <circle
                                key={`dot-${node.hash}`}
                                cx={node.x * LANE_WIDTH + LANE_WIDTH / 2}
                                cy={node.y * ROW_HEIGHT + ROW_HEIGHT / 2}
                                r={DOT_SIZE}
                                fill={node.color}
                                stroke={node.color}
                                strokeWidth={STROKE_WIDTH}
                            />
                        ))}
                    </svg>

                    {/* List Rows */}
                    <div style={{ width: '100%' }}>
                        {nodes.map((node) => {
                            const isSelected = selectedHashes ? selectedHashes.has(node.hash) : selectedHash === node.hash;
                            const selectedCount = selectedHashes?.size ?? (selectedHash ? 1 : 0);
                            const menuItems: ContextMenuItem[] = [
                                {
                                    label: "Reset to here",
                                    icon: <i className="iconoir-refresh-circle text-[14px]" aria-hidden="true" />,
                                    onClick: () => onResetToCommit?.(node.hash),
                                },
                            ];
                            if (onRevertCommit) {
                                menuItems.push({
                                    label: "Revert commit",
                                    icon: <i className="iconoir-u-turn-arrow-left text-[14px]" aria-hidden="true" />,
                                    onClick: () => onRevertCommit(node.hash, node.message),
                                });
                            }
                            if (onCreateTag) {
                                menuItems.push({
                                    label: "Create tag",
                                    icon: <i className="iconoir-bookmark text-[14px]" aria-hidden="true" />,
                                    onClick: () => onCreateTag(node.hash),
                                });
                            }
                            if (onCherryPickCommit) {
                                menuItems.push({
                                    label: "Cherry-pick commit",
                                    icon: <i className="iconoir-git-fork text-[14px]" aria-hidden="true" />,
                                    onClick: () => onCherryPickCommit(node.hash, node.message),
                                });
                            }
                            if (onCherryPickSelectedCommits && selectedCount > 1 && isSelected) {
                                menuItems.push({
                                    label: `Cherry-pick ${selectedCount} selected commits`,
                                    icon: <i className="iconoir-git-fork text-[14px]" aria-hidden="true" />,
                                    onClick: onCherryPickSelectedCommits,
                                });
                            }

                            if (onRewordCommit && localBranches && localBranches.length > 0) {
                                // Clean up refs: remove parentheses and split
                                const refs = node.refs ? node.refs.replace(/[()]/g, '').split(',').map(r => r.trim()) : [];
                                let targetBranch: string | null = null;

                                for (const ref of refs) {
                                    // Handle "HEAD -> branch" format
                                    const cleanRef = ref.replace(/^HEAD\s*->\s*/, '');

                                    // Check if it is in localBranches
                                    if (localBranches.includes(cleanRef)) {
                                        targetBranch = cleanRef;
                                        // Prioritize current branch if found
                                        if (currentBranch && cleanRef === currentBranch) {
                                            break;
                                        }
                                    }
                                }

                                if (targetBranch) {
                                    menuItems.push({
                                        label: "Reword commit",
                                        icon: <i className="iconoir-edit-pencil text-[14px]" aria-hidden="true" />,
                                        onClick: () => onRewordCommit(node.hash, node.message, node.body ?? '', targetBranch!),
                                    });
                                }
                            }


                            // Process refs to combine local and tracking remote branches
                            const processRefs = () => {
                                if (!node.refs) return [];

                                const rawRefs = node.refs.replace(/^\s*\((.*)\)\s*$/, '$1').split(',').map(r => {
                                    const isHead = r.startsWith('HEAD -> ');
                                    const name = normalizeDecoratedRef(r.replace(/^HEAD\s*->\s*/, '').trim());
                                    return { raw: r, name, isHead };
                                });

                                const result: {
                                    displayName: string;
                                    primaryRef: string;
                                    secondaryRef?: string;
                                    isHead: boolean
                                }[] = [];

                                const processedIndices = new Set<number>();
                                const isHidden = (name: string) => hiddenBranches && (hiddenBranches.has(name) || hiddenBranches.has(`remotes/${name}`));

                                // First pass: find local branches and their tracking remotes
                                rawRefs.forEach((ref, idx) => {
                                    if (processedIndices.has(idx)) return;

                                    // Only attempt to combine if local branch is visible
                                    if (localBranches.includes(ref.name) && !isHidden(ref.name)) {
                                        const tracking = trackingInfo?.[ref.name];
                                        if (tracking && tracking.upstream) {
                                            const normalizedUpstream = normalizeDecoratedRef(tracking.upstream.trim());
                                            const upstreamCandidates = new Set([
                                                normalizedUpstream,
                                                normalizeDecoratedRef(`remotes/${normalizedUpstream}`),
                                                normalizeDecoratedRef(`refs/remotes/${normalizedUpstream}`),
                                            ]);
                                            const upstreamIdx = rawRefs.findIndex(
                                                (r, i) => i !== idx && !processedIndices.has(i) && upstreamCandidates.has(r.name)
                                            );

                                            if (upstreamIdx !== -1) {
                                                const upstreamRef = rawRefs[upstreamIdx];
                                                const parts = normalizedUpstream.split('/');
                                                const remoteName = parts[0];

                                                result.push({
                                                    displayName: `${ref.name} (${remoteName})`,
                                                    primaryRef: ref.name,
                                                    secondaryRef: upstreamRef.name,
                                                    isHead: ref.isHead
                                                });

                                                processedIndices.add(idx);
                                                processedIndices.add(upstreamIdx);
                                                return;
                                            }
                                        }
                                    }
                                });

                                // Second pass: add remaining refs
                                rawRefs.forEach((ref, idx) => {
                                    if (!processedIndices.has(idx)) {
                                        // Skip hidden branches
                                        if (isHidden(ref.name)) return;

                                        result.push({
                                            displayName: getRefDisplayName(ref.name),
                                            primaryRef: ref.name,
                                            isHead: ref.isHead
                                        });
                                    }
                                });

                                return result;
                            };

                            const processedTags = processRefs();

                            return (
                            <ContextMenu key={node.hash} items={menuItems}>
                                <div
                                    className={cn(
                                        "flex items-center hover:bg-base-200 border-b border-base-200 last:border-0 cursor-pointer transition-colors text-xs",
                                        isSelected && "bg-primary/10"
                                    )}
                                    style={{ height: ROW_HEIGHT }}
                                    onClick={(e) => onSelectCommit?.(node.hash, {
                                        isMultiSelect: e.metaKey || e.ctrlKey,
                                        isRangeSelect: e.shiftKey,
                                    })}
                                >
                                    {/* Spacing for Graph */}
                                    <div style={{ width: width, flexShrink: 0 }} />

                                    {/* Content */}
                                    <div className="flex flex-1 gap-4 overflow-hidden pr-4 items-center">
                                        <div className="flex-1 truncate flex items-center gap-2">
                                            {/* Refs Pills */}
                                            {processedTags.map((tag, idx) => {
                                                const isCurrent = currentBranch && (
                                                    tag.primaryRef === currentBranch ||
                                                    tag.isHead && tag.primaryRef === currentBranch
                                                );
                                                const isGitTag = tag.primaryRef.startsWith('tag:');
                                                const tagColors = isGitTag
                                                    ? { textColor: '#374151', backgroundColor: '#e5e7eb' }
                                                    : getBranchTagColors(tag.primaryRef);
                                                const hasAssociatedSession = !isGitTag && !!isBranchSessionAssociated?.(tag.primaryRef);

                                                const tagElement = (
                                                    <span className="relative inline-flex shrink-0">
                                                        <span
                                                            className={cn(
                                                                "text-[10px] px-1.5 rounded-full whitespace-nowrap shrink-0",
                                                                isCurrent && "font-bold",
                                                                hasAssociatedSession && "pr-4"
                                                            )}
                                                            style={{
                                                                color: tagColors.textColor,
                                                                backgroundColor: tagColors.backgroundColor
                                                            }}
                                                            title={tag.displayName}
                                                        >
                                                            <HighlightedText text={tag.displayName} searchQuery={searchQuery} />
                                                        </span>
                                                        {hasAssociatedSession && <SessionAssociationDot className="top-0.5 right-0.5 z-10" />}
                                                    </span>
                                                );

                                                const branchMenuItems = getBranchTagContextMenuItems?.(tag.primaryRef) || [];

                                                if (branchMenuItems.length === 0) {
                                                    return <span key={idx} className="shrink-0">{tagElement}</span>;
                                                }

                                                return (
                                                    <ContextMenu
                                                        key={idx}
                                                        items={branchMenuItems}
                                                        containerClassName="inline-flex shrink-0"
                                                    >
                                                        {tagElement}
                                                    </ContextMenu>
                                                );
                                            })}
                                            <span className={cn("truncate min-w-0 max-w-[600px]", isSelected ? "font-semibold" : "")} title={node.message}>
                                                <HighlightedText text={node.message} searchQuery={searchQuery} />
                                            </span>
                                        </div>
                                        <div className="w-32 truncate opacity-70 text-right">
                                            <HighlightedText text={node.author_name} searchQuery={searchQuery} />
                                        </div>
                                        <div className="w-20 truncate opacity-50 font-mono text-right">
                                            <HighlightedText text={node.hash.substring(0, 7)} searchQuery={searchQuery} />
                                        </div>
                                        <div className="w-32 truncate opacity-70 text-right">
                                            {new Date(node.date).toLocaleString(undefined, {
                                                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
                                            })}
                                        </div>
                                    </div>
                                </div>
                            </ContextMenu>
                            );
                        })}
                        
                        {/* Loading More Indicator */}
                        {isLoadingMore && (
                            <div className="flex items-center justify-center py-8 border-b border-base-300">
                                <span className="loading loading-spinner text-base-content/50"></span>
                                <span className="ml-2 text-sm opacity-70">Loading more commits...</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
});
