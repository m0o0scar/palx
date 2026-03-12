const ORDERED_LIST_ITEM_PATTERN = /^(\s*)(\d+)[.)](\s+.*)?$/;
const UNORDERED_LIST_ITEM_PATTERN = /^(\s*)[-+*](\s+.*)?$/;
const FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})/;
const ORDERED_CHILD_INDENT = '  ';

function isBlankLine(line: string) {
  return line.trim().length === 0;
}

function isBlockBoundary(line: string) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('>') || trimmed.startsWith('|');
}

function isContinuationLine(line: string, baseIndent: string) {
  if (isBlankLine(line)) return true;
  if (isBlockBoundary(line)) return false;

  const trimmed = line.trimStart();
  if (!trimmed) return true;
  if (ORDERED_LIST_ITEM_PATTERN.test(line) || UNORDERED_LIST_ITEM_PATTERN.test(line)) return false;

  return line.length > baseIndent.length && line.startsWith(`${baseIndent} `);
}

function isSiblingBulletLine(line: string, baseIndent: string) {
  const bulletMatch = line.match(UNORDERED_LIST_ITEM_PATTERN);
  return Boolean(bulletMatch && bulletMatch[1] === baseIndent);
}

export function normalizeMarkdownLists(source: string) {
  if (!source) return source;

  const lines = source.split('\n');
  const normalized = [...lines];
  let insideFence = false;
  let fenceMarker = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(FENCE_PATTERN);

    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (!insideFence) {
        insideFence = true;
        fenceMarker = marker[0];
      } else if (marker[0] === fenceMarker) {
        insideFence = false;
        fenceMarker = '';
      }
      continue;
    }

    if (insideFence) continue;

    const orderedMatch = line.match(ORDERED_LIST_ITEM_PATTERN);
    if (!orderedMatch) continue;

    const baseIndent = orderedMatch[1];
    let bulletStart = index + 1;
    while (bulletStart < lines.length && isBlankLine(lines[bulletStart])) {
      bulletStart += 1;
    }

    if (bulletStart >= lines.length) continue;
    if (isBlockBoundary(lines[bulletStart])) continue;

    const bulletMatch = lines[bulletStart].match(UNORDERED_LIST_ITEM_PATTERN);
    if (!bulletMatch || bulletMatch[1] !== baseIndent) continue;

    let bulletEnd = bulletStart + 1;
    while (bulletEnd < lines.length) {
      const candidate = lines[bulletEnd];
      if (isSiblingBulletLine(candidate, baseIndent) || isContinuationLine(candidate, baseIndent)) {
        bulletEnd += 1;
        continue;
      }
      break;
    }

    let nextOrdered = bulletEnd;
    while (nextOrdered < lines.length && isBlankLine(lines[nextOrdered])) {
      nextOrdered += 1;
    }

    if (nextOrdered >= lines.length) continue;

    const nextOrderedMatch = lines[nextOrdered].match(ORDERED_LIST_ITEM_PATTERN);
    if (!nextOrderedMatch || nextOrderedMatch[1] !== baseIndent) continue;

    for (let bulletIndex = bulletStart; bulletIndex < bulletEnd; bulletIndex += 1) {
      if (isBlankLine(lines[bulletIndex])) continue;
      normalized[bulletIndex] = `${baseIndent}${ORDERED_CHILD_INDENT}${lines[bulletIndex].slice(baseIndent.length)}`;
    }
  }

  return normalized.join('\n');
}
