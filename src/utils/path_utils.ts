import * as path from 'path';

/**
 * Resolve a source path: if already absolute return it normalized,
 * otherwise join with the given base directory and normalize.
 */
export function resolveSourcePath(aBaseDir: string, aSourcePath: string): string {
    const isAbs = /^([a-zA-Z]:[\\/]|\/)/.test(aSourcePath);
    if (isAbs) { return path.normalize(aSourcePath); }
    return path.normalize(path.join(aBaseDir, aSourcePath));
}

/** Escape special regex characters in a string. */
export function escapeRegex(aStr: string): string {
    return aStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
