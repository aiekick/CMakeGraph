// ------------------------------------------------------------
// Shared utility functions for the graph webview.
// Pure helpers with no side effects on global state.
// ------------------------------------------------------------

import { NODE_MIN_W, NODE_PAD_X, SIM_CLAMP, type SimVars } from './types';

// ------------------------------------------------------------
// CSS / Theme helpers
// ------------------------------------------------------------

export function getCssVar(aName: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(aName).trim();
}

/** Compute perceived luminance from a hex color (0..1) */
export function hexToLuminance(aHex: string): number {
    const r = parseInt(aHex.slice(1, 3), 16);
    const g = parseInt(aHex.slice(3, 5), 16);
    const b = parseInt(aHex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Returns true when the current VS Code theme is light */
export function isLightTheme(): boolean {
    const bg = getCssVar('--vscode-editor-background');
    if (!bg) { return false; }
    const hex = bg.startsWith('#') ? bg : '#1e1e1e';
    return hexToLuminance(hex) > 0.5;
}

/** Foreground color that contrasts with the editor background */
export function themeFg(): string {
    return getCssVar('--vscode-editor-foreground') || (isLightTheme() ? '#000000' : '#ffffff');
}

/** Edge color with given alpha — uses foreground color so it's visible on any theme */
export function themeEdgeColor(aAlpha: number): string {
    const light = isLightTheme();
    return light ? `rgba(0, 0, 0, ${aAlpha})` : `rgba(255, 255, 255, ${aAlpha})`;
}

export function darken(aHex: string): string {
    return adjustBrightness(aHex, -0.3);
}

export function adjustBrightness(aHex: string, aFactor: number): string {
    const r = parseInt(aHex.slice(1, 3), 16);
    const g = parseInt(aHex.slice(3, 5), 16);
    const b = parseInt(aHex.slice(5, 7), 16);
    const adj = (c: number) => Math.max(0, Math.min(255, Math.round(c + c * aFactor)));
    return `#${adj(r).toString(16).padStart(2, '0')}${adj(g).toString(16).padStart(2, '0')}${adj(b).toString(16).padStart(2, '0')}`;
}

/** Returns '#000000' or '#ffffff' depending on which has better contrast */
export function contrastTextColor(aHex: string): string {
    return hexToLuminance(aHex) > 0.5 ? '#000000' : '#ffffff';
}

// ------------------------------------------------------------
// Text measurement (uses offscreen canvas)
// ------------------------------------------------------------

const measure_ctx = document.createElement('canvas').getContext('2d')!;

export function measureNodeWidth(aLabel: string): number {
    const font = getCssVar('--vscode-font-family') || 'monospace';
    measure_ctx.font = `bold 11px ${font}`;
    const text_w = measure_ctx.measureText(aLabel).width;
    return Math.max(NODE_MIN_W, text_w + NODE_PAD_X * 2);
}

// ------------------------------------------------------------
// HTML helpers
// ------------------------------------------------------------

export function escapeHtml(aS: string): string {
    return aS.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ------------------------------------------------------------
// Simulation helpers
// ------------------------------------------------------------

export function clampSimVar(aKey: keyof SimVars, aValue: number): number {
    const [lo, hi] = SIM_CLAMP[aKey];
    return Math.max(lo, Math.min(hi, aValue));
}

// ------------------------------------------------------------
// Common node drawing helpers (used by both 2D and 3D renderers)
// ------------------------------------------------------------

/** Draw a rounded rectangle (centered on aCx, aCy). Fills + strokes unless aStrokeOnly. */
export function drawBox(
    aCtx: CanvasRenderingContext2D,
    aCx: number, aCy: number, aW: number, aH: number, aR: number,
    aStrokeOnly = false,
): void {
    const x = aCx - aW / 2;
    const y = aCy - aH / 2;
    aCtx.beginPath();
    aCtx.moveTo(x + aR, y);
    aCtx.lineTo(x + aW - aR, y);
    aCtx.arcTo(x + aW, y, x + aW, y + aR, aR);
    aCtx.lineTo(x + aW, y + aH - aR);
    aCtx.arcTo(x + aW, y + aH, x + aW - aR, y + aH, aR);
    aCtx.lineTo(x + aR, y + aH);
    aCtx.arcTo(x, y + aH, x, y + aH - aR, aR);
    aCtx.lineTo(x, y + aR);
    aCtx.arcTo(x, y, x + aR, y, aR);
    aCtx.closePath();
    if (!aStrokeOnly) { aCtx.fill(); }
    aCtx.stroke();
}

/** Draw a single node box with all decorations (halo, pin, selection, label).
 *  Used by both 2D and 3D renderers to avoid duplication. */
export function drawNodeBox(
    aCtx: CanvasRenderingContext2D,
    aSx: number, aSy: number, aSw: number, aSh: number,
    aScale: number,
    aNode: { id: string; label: string; color: string },
    aAlpha: number,
    aIsSelected: boolean,
    aIsPinned: boolean,
    aIsFocusedRoot: boolean,
): void {
    const color = aNode.color;
    const border_color = darken(color);

    const s2 = 2 * aScale;
    const s3 = 3 * aScale;
    const s4 = 4 * aScale;
    const s8 = 8 * aScale;

    aCtx.globalAlpha = aAlpha;
    aCtx.fillStyle = color;
    aCtx.strokeStyle = border_color;
    aCtx.lineWidth = Math.max(1, s2);
    const r = Math.min(s4, aSw * 0.08);
    drawBox(aCtx, aSx, aSy, aSw, aSh, r);

    // Focused root node halo (golden glow)
    if (aIsFocusedRoot) {
        const light = isLightTheme();
        const halo_color = light ? '#B87800' : '#FFD700';
        aCtx.save();
        if (!light) {
            aCtx.shadowColor = halo_color;
            aCtx.shadowBlur = Math.max(12, 20 * aScale);
        }
        aCtx.strokeStyle = halo_color;
        aCtx.lineWidth = Math.max(3, s4);
        drawBox(aCtx, aSx, aSy, aSw + s8, aSh + s8, r + s4, true);
        aCtx.restore();
        aCtx.globalAlpha = aAlpha;
    }

    // Pinned node indicator (cyan border)
    if (aIsPinned) {
        aCtx.strokeStyle = isLightTheme() ? '#00868B' : '#00CED1';
        aCtx.lineWidth = Math.max(2, s3);
        drawBox(aCtx, aSx, aSy, aSw + s4, aSh + s4, r + s2, true);
    }

    // Selection border
    if (aIsSelected) {
        aCtx.strokeStyle = isLightTheme() ? '#000000' : '#ffffff';
        aCtx.lineWidth = Math.max(2, s3);
        const sel_offset = aIsPinned ? s8 : s4;
        drawBox(aCtx, aSx, aSy, aSw + sel_offset, aSh + sel_offset, r + s2, true);
    }

    // Label
    const min_font_size = 3;
    const font_size = Math.max(min_font_size, 11 * aScale);
    if (font_size > min_font_size) {
        const text_color = contrastTextColor(color);
        aCtx.fillStyle = text_color;
        aCtx.font = `bold ${font_size}px ${getCssVar('--vscode-font-family') || 'monospace'}`;
        aCtx.textAlign = 'center';
        aCtx.textBaseline = 'middle';
        aCtx.fillText(aNode.label, aSx, aSy);
    }

    aCtx.globalAlpha = 1;
}
