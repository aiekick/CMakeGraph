// Edge direction / Edge style enums — duplicated here to keep the webview self-contained
// (no imports, so tsc CommonJS output works in the browser context).
// Must stay in sync with WorkspaceConfig.Graph.EdgeDirection in config/workspace/types.ts

const enum EdgeDirection {
    USED_BY = 'used-by',
    IS_USING = 'is-using',
}

const enum EdgeStyle {
    TAPERED = 'tapered',
    CHEVRONS = 'chevrons',
    LINE = 'line',
}

// ------------------------------------------------------------
// VS Code API
// ------------------------------------------------------------
declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const m_vscode = acquireVsCodeApi();

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
interface GraphNode {
    id: string;
    label: string;
    type: string;
    color: string;
    shape: string;
    sourcePath: string;
}

interface GraphEdge {
    from: string;
    to: string;
}

interface LayoutNode {
    node: GraphNode;
    x: number;   // world position (center)
    y: number;
    w: number;   // node width (computed from label)
    vx: number;  // velocity for force simulation
    vy: number;
    mass: number; // mass for force simulation
    pinned: boolean; // if true, simulation forces are ignored (can still be dragged)
}

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
let m_all_nodes: GraphNode[] = [];
let m_all_edges: GraphEdge[] = [];
let m_layout_nodes: LayoutNode[] = [];
let m_active_filters = new Set<string>();
let m_selected_node_id: string | null = null;
let m_edge_style: EdgeStyle = EdgeStyle.TAPERED;
let m_edge_direction: EdgeDirection = EdgeDirection.USED_BY; // default to "targets used by" which is more intuitive for most users
let m_sim_enabled = true;       // user toggle: allows/prevents sim from running
let m_auto_pause_during_drag = false;
let m_search_filter = '';
let m_search_mode: 'name' | 'path' = 'name';
let m_search_filter_mode: 'dim' | 'hide' = 'hide'; // dim = lower opacity, hide = remove from graph
let m_minimap_enabled = true;
let m_settings_collapse_state: Record<string, boolean> = { edges: false, colors: true, simulation: true, display: false, controls: false };
let m_settings_panel_visible = false;
let m_total_sim_energy = 0;
let m_frame_delta_ms = 0;
let m_frame_last_time = 0;
let m_footer_loaded = false;

// Default values received from the provider (workspace config defaults).
// Used by reset buttons to restore a widget to its default value.
let m_provider_defaults: Record<string, any> = {};

// Focused view state: when non-null, only show the recursively connected subgraph
let m_focused_node_id: string | null = null;
let m_focus_history: { nodeId: string; label: string }[] = [];
let m_focus_visible_ids: Set<string> | null = null; // precomputed set of visible node ids in focus mode
let m_focus_depth = 0;       // current depth limit for focused subgraph
let m_focus_max_depth = 0;   // deepest level reachable from focused node
let m_focus_node_depths: Map<string, number> | null = null; // nodeId → BFS depth from focused node

const TARGET_TYPES = [
    'EXECUTABLE', 'STATIC_LIBRARY', 'SHARED_LIBRARY',
    'MODULE_LIBRARY', 'OBJECT_LIBRARY', 'INTERFACE_LIBRARY',
    'SYSTEM_LIBRARY',
];

// Node sizing
const NODE_H = 25;
const NODE_PAD_X = 10;
const NODE_MIN_W = 60;

// Canvas / camera state
let m_canvas: HTMLCanvasElement | null = null;
let m_context: CanvasRenderingContext2D | null = null;
let m_cam_x = 0;
let m_cam_y = 0;
let m_zoom = 1;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 10;
const GRID_SIZE = 40;

// Interaction state
let m_is_panning = false;
let m_is_dragging_node = false;
let m_was_panning = false;
let m_drag_node: LayoutNode | null = null;
let m_pan_start_x = 0;
let m_pan_start_y = 0;
let m_cam_start_x = 0;
let m_cam_start_y = 0;
let m_drag_offset_x = 0;
let m_drag_offset_y = 0;
let m_first_layout = true;

// ------------------------------------------------------------
// Force simulation parameters
// Actual values come from the provider (workspace settings).
// These are just initial placeholders until applySettingsFromProvider is called.
// ------------------------------------------------------------

interface SimVars {
    repulsion: number;
    attraction: number;
    gravity: number;
    linkLength: number;
    minDistance: number;
    stepsPerFrame: number;
    threshold: number;
    damping: number;
    taperedWidth: number;
}

// Clamping definitions for each parameter: [min, max]
const SIM_CLAMP: Record<keyof SimVars, [number, number]> = {
    repulsion: [100, 200000],
    attraction: [0.0001, 2],
    gravity: [0.0001, 2],
    linkLength: [0.001, 10],
    minDistance: [1, 50000],
    stepsPerFrame: [1, 20],
    threshold: [0.001, 500],
    damping: [0.01, 0.99],
    taperedWidth: [0.1, 10],
};

function clampSimVar(aKey: keyof SimVars, aValue: number): number {
    const [lo, hi] = SIM_CLAMP[aKey];
    return Math.max(lo, Math.min(hi, aValue));
}

const m_sim_vars: SimVars = {
    repulsion: 10000,
    attraction: 0.1,
    gravity: 0.001,
    linkLength: 0.1,
    minDistance: 50,
    stepsPerFrame: 5,
    threshold: 2,
    damping: 0.85,
    taperedWidth: 1.0,
};

let m_sim_running = false; // whether the simulation loop is currently running (can be paused by user)
let m_sim_anim_frame: number | null = null; // current animation frame id for simulation loop, used to cancel when needed

// ------------------------------------------------------------
// State persistence (camera only, survives webview refresh)
// Settings are persisted to workspace via updateSetting messages.
// ------------------------------------------------------------
interface PersistedState {
    camX?: number;
    camY?: number;
    zoom?: number;
}

function saveState(): void {
    m_vscode.setState({ camX: m_cam_x, camY: m_cam_y, zoom: m_zoom } as PersistedState);
}

function restoreState(): boolean {
    const s = m_vscode.getState() as PersistedState | undefined;
    if (!s || s.camX === undefined) { return false; }
    m_cam_x = s.camX;
    m_cam_y = s.camY!;
    m_zoom = s.zoom!;
    return true;
}

// ------------------------------------------------------------
// Search filter helpers
// ------------------------------------------------------------
function nodeMatchesSearch(aNode: GraphNode): boolean {
    if (!m_search_filter) { return true; }
    const query = m_search_filter.toLowerCase();
    const target = m_search_mode === 'name' ? aNode.label : aNode.sourcePath;
    // Support regex for power users: if the query is a valid regex, use it
    try {
        if (m_search_filter.includes('*') || m_search_filter.includes('(') || m_search_filter.includes('[')) {
            return new RegExp(m_search_filter, 'i').test(target);
        }
    } catch { /* not a valid regex, fallback to simple match */ }
    return target.toLowerCase().includes(query);
}

/**
 * Returns true if a node should be completely excluded from the graph
 * (simulation + rendering), like type filters in the header.
 * Combines: activeFilters (type checkboxes) + hide-mode search + hide-mode focus.
 */
function isNodeFiltered(aNode: GraphNode): boolean {
    // Type filter from header checkboxes
    if (m_active_filters.has(aNode.type)) { return true; }
    // In "hide" mode, search and focus act as real filters
    if (m_search_filter_mode === 'hide') {
        if (m_search_filter && !nodeMatchesSearch(aNode)) { return true; }
        if (m_focus_visible_ids && !m_focus_visible_ids.has(aNode.id)) { return true; }
    }
    return false;
}

// ------------------------------------------------------------
// Text measurement (uses offscreen canvas)
// ------------------------------------------------------------
const measure_ctx = document.createElement('canvas').getContext('2d')!;

function measureNodeWidth(aLabel: string): number {
    const font = getCssVar('--vscode-font-family') || 'monospace';
    measure_ctx.font = `bold 11px ${font}`;
    const text_w = measure_ctx.measureText(aLabel).width;
    return Math.max(NODE_MIN_W, text_w + NODE_PAD_X * 2);
}

// ------------------------------------------------------------
// Canvas setup
// ------------------------------------------------------------
function setupCanvas(): void {
    const container = document.getElementById('graph-container')!;
    container.style.display = 'block';
    document.getElementById('empty-message')!.style.display = 'none';

    if (!m_canvas) {
        m_canvas = document.createElement('canvas');
        m_canvas.tabIndex = 0;
        m_canvas.style.display = 'block';
        m_canvas.style.width = '100%';
        m_canvas.style.height = '100%';
        m_canvas.style.outline = 'none';
        container.innerHTML = '';
        container.appendChild(m_canvas);
        m_context = m_canvas.getContext('2d')!;
        attachCanvasEvents(m_canvas);
    }

    resizeCanvas();
}

function resizeCanvas(): void {
    if (!m_canvas) { return; }
    const container = m_canvas.parentElement!;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    m_canvas.width = rect.width * dpr;
    m_canvas.height = rect.height * dpr;
    m_canvas.style.width = `${rect.width}px`;
    m_canvas.style.height = `${rect.height}px`;
    if (m_context) {
        m_context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    draw();
}

// ------------------------------------------------------------
// Drawing
// ------------------------------------------------------------
function draw(): void {
    if (!m_canvas || !m_context) { return; }
    const w = m_canvas.clientWidth;
    const h = m_canvas.clientHeight;

    m_context.clearRect(0, 0, w, h);

    const bg = getCssVar('--vscode-editor-background') || (isLightTheme() ? '#ffffff' : '#1e1e1e');
    m_context.fillStyle = bg;
    m_context.fillRect(0, 0, w, h);

    drawGrid(w, h);
    drawEdges(w, h);
    drawNodes(w, h);
    if (m_minimap_enabled) { drawMinimap(w, h); }
}

function worldToScreen(aWx: number, aWy: number): [number, number] {
    return [m_cam_x + aWx * m_zoom, m_cam_y + aWy * m_zoom];
}

// ------------------------------------------------------------
// Edge drawing (supports tapered, chevrons, or plain line)
// ------------------------------------------------------------
function drawEdges(aW: number, aH: number): void {
    if (!m_context || m_all_edges.length === 0) { return; }

    const node_map = new Map<string, LayoutNode>();
    for (const ln of m_layout_nodes) {
        if (!isNodeFiltered(ln.node)) {
            node_map.set(ln.node.id, ln);
        }
    }

    const has_search = m_search_filter.length > 0;

    // Draw normal edges, then highlighted on top
    for (const edge of m_all_edges) {
        const from_ln = node_map.get(edge.from);
        const to_ln = node_map.get(edge.to);
        if (!from_ln || !to_ln) { continue; }

        const is_highlighted = m_selected_node_id && (edge.from === m_selected_node_id || edge.to === m_selected_node_id);
        if (is_highlighted) { continue; }

        const [x1, y1] = worldToScreen(from_ln.x, from_ln.y);
        const [x2, y2] = worldToScreen(to_ln.x, to_ln.y);
        const margin = 50;
        if (Math.max(x1, x2) < -margin || Math.min(x1, x2) > aW + margin) { continue; }
        if (Math.max(y1, y2) < -margin || Math.min(y1, y2) > aH + margin) { continue; }

        // In "dim" mode, dim edges where neither endpoint matches search/focus
        const from_matches_search = !has_search || nodeMatchesSearch(from_ln.node);
        const to_matches_search = !has_search || nodeMatchesSearch(to_ln.node);
        const from_in_focus = isNodeVisibleInFocus(from_ln.node.id);
        const to_in_focus = isNodeVisibleInFocus(to_ln.node.id);
        const search_dim = has_search && !from_matches_search && !to_matches_search;
        const focus_dim = m_focused_node_id !== null && !from_in_focus && !to_in_focus;
        const edge_alpha = (search_dim || focus_dim) ? 0.04 : 0.15;
        drawEdgeStyled(m_context, x1, y1, x2, y2, themeEdgeColor(edge_alpha));
    }

    // Highlighted edges with gradient: node color -> white along the arrow
    if (m_selected_node_id) {
        for (const edge of m_all_edges) {
            const is_highlighted = edge.from === m_selected_node_id || edge.to === m_selected_node_id;
            if (!is_highlighted) { continue; }
            const from_ln = node_map.get(edge.from);
            const to_ln = node_map.get(edge.to);
            if (!from_ln || !to_ln) { continue; }
            const [x1, y1] = worldToScreen(from_ln.x, from_ln.y);
            const [x2, y2] = worldToScreen(to_ln.x, to_ln.y);

            // Compute visual arrow direction (after edgeDirection swap)
            // The wide end (base) is at sx1,sy1 and the tip at sx2,sy2
            let sx1 = x1, sy1 = y1, sx2 = x2, sy2 = y2;
            let base_node = from_ln;
            if (m_edge_direction === EdgeDirection.USED_BY) {
                sx1 = x2; sy1 = y2; sx2 = x1; sy2 = y1;
                base_node = to_ln;
            }

            // Gradient from the base node's color (wide end) -> foreground (tip)
            const grad = m_context.createLinearGradient(sx1, sy1, sx2, sy2);
            grad.addColorStop(0, base_node.node.color);
            grad.addColorStop(1, themeFg());

            drawEdgeStyled(m_context, x1, y1, x2, y2, grad, 0.6);
        }
    }
}

/** Dispatch to the correct edge style, respecting edge direction */
function drawEdgeStyled(
    aCanvas: CanvasRenderingContext2D,
    aX1: number, aY1: number, aX2: number, aY2: number,
    aColor: string | CanvasGradient, aAlpha = 1,
): void {
    // Swap direction if inverted
    let sx1 = aX1, sy1 = aY1, sx2 = aX2, sy2 = aY2;
    if (m_edge_direction === EdgeDirection.USED_BY) {
        sx1 = aX2; sy1 = aY2; sx2 = aX1; sy2 = aY1;
    }
    switch (m_edge_style) {
        case EdgeStyle.TAPERED: drawTaperedEdge(aCanvas, sx1, sy1, sx2, sy2, aColor, aAlpha); break;
        case EdgeStyle.CHEVRONS: drawChevronEdge(aCanvas, sx1, sy1, sx2, sy2, aColor, aAlpha); break;
        case EdgeStyle.LINE: drawLineEdge(aCanvas, sx1, sy1, sx2, sy2, aColor, aAlpha); break;
    }
}

/** Tapered triangle: wider at "from", narrow at "to" */
function drawTaperedEdge(
    aCanvas: CanvasRenderingContext2D,
    aX1: number, aY1: number, aX2: number, aY2: number,
    aColor: string | CanvasGradient, aAlpha = 1,
): void {
    const dx = aX2 - aX1;
    const dy = aY2 - aY1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2) { return; }

    const px = -dy / len;
    const py = dx / len;

    const wide_half = Math.max(1.5, 3 * m_zoom * m_sim_vars.taperedWidth);
    const narrow_half = Math.max(0.3, 0.5 * m_zoom * m_sim_vars.taperedWidth);

    aCanvas.globalAlpha = aAlpha;
    aCanvas.fillStyle = aColor;
    aCanvas.beginPath();
    aCanvas.moveTo(aX1 + px * wide_half, aY1 + py * wide_half);
    aCanvas.lineTo(aX2 + px * narrow_half, aY2 + py * narrow_half);
    aCanvas.lineTo(aX2 - px * narrow_half, aY2 - py * narrow_half);
    aCanvas.lineTo(aX1 - px * wide_half, aY1 - py * wide_half);
    aCanvas.closePath();
    aCanvas.fill();
    aCanvas.globalAlpha = 1;
}

/** Chevrons (>>>) at the midpoint of a line */
function drawChevronEdge(
    aCanvas: CanvasRenderingContext2D,
    aX1: number, aY1: number, aX2: number, aY2: number,
    aColor: string | CanvasGradient, aAlpha = 1,
): void {
    const dx = aX2 - aX1;
    const dy = aY2 - aY1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2) { return; }

    aCanvas.globalAlpha = aAlpha;
    aCanvas.strokeStyle = aColor;
    aCanvas.lineWidth = Math.max(1, 1.5 * m_zoom);
    aCanvas.beginPath();
    aCanvas.moveTo(aX1, aY1);
    aCanvas.lineTo(aX2, aY2);
    aCanvas.stroke();

    const ux = dx / len;
    const uy = dy / len;
    const chev_size = Math.max(3, 5 * m_zoom);
    const gap = Math.max(2, 4 * m_zoom);
    const mx = (aX1 + aX2) / 2;
    const my = (aY1 + aY2) / 2;

    aCanvas.lineWidth = Math.max(1, 1.2 * m_zoom);
    for (let i = -1; i <= 1; i++) {
        const cx = mx + ux * i * gap;
        const cy = my + uy * i * gap;
        aCanvas.beginPath();
        aCanvas.moveTo(cx - ux * chev_size - uy * chev_size, cy - uy * chev_size + ux * chev_size);
        aCanvas.lineTo(cx, cy);
        aCanvas.lineTo(cx - ux * chev_size + uy * chev_size, cy - uy * chev_size - ux * chev_size);
        aCanvas.stroke();
    }
    aCanvas.globalAlpha = 1;
}

/** Simple straight line (no direction indicator) */
function drawLineEdge(
    aCanvas: CanvasRenderingContext2D,
    aX1: number, aY1: number, aX2: number, aY2: number,
    aColor: string | CanvasGradient, aAlpha = 1,
): void {
    aCanvas.globalAlpha = aAlpha;
    aCanvas.strokeStyle = aColor;
    aCanvas.lineWidth = Math.max(1, 1.5 * m_zoom);
    aCanvas.beginPath();
    aCanvas.moveTo(aX1, aY1);
    aCanvas.lineTo(aX2, aY2);
    aCanvas.stroke();
    aCanvas.globalAlpha = 1;
}

// ------------------------------------------------------------
// Node drawing (all rectangular)
// ------------------------------------------------------------
function drawNodes(aW: number, aH: number): void {
    if (!m_context || m_layout_nodes.length === 0) { return; }

    const min_font_size = 3;
    const font_size = Math.max(min_font_size, 11 * m_zoom);

    const has_search = m_search_filter.length > 0;

    for (const ln of m_layout_nodes) {
        if (isNodeFiltered(ln.node)) { continue; }

        const [sx, sy] = worldToScreen(ln.x, ln.y);
        const sw = ln.w * m_zoom;
        const sh = NODE_H * m_zoom;

        // Cull off-screen
        if (((sx + sw / 2) < 0) ||
            ((sx - sw / 2) > aW) ||
            ((sy + sh / 2) < 0) ||
            ((sy - sh / 2) > aH)) {
            continue;
        }

        // In "dim" mode, reduce opacity for non-matching nodes
        const matches_search = !has_search || nodeMatchesSearch(ln.node);
        const in_focus = isNodeVisibleInFocus(ln.node.id);
        const node_alpha = (!matches_search || !in_focus) ? 0.12 : 1;

        const color = ln.node.color;
        const border_color = darken(color);

        const zoom2 = 2 * m_zoom;
        const zoom3 = 3 * m_zoom;
        const zoom4 = 4 * m_zoom;
        const zoom8 = 8 * m_zoom;

        m_context.globalAlpha = node_alpha;
        m_context.fillStyle = color;
        m_context.strokeStyle = border_color;
        m_context.lineWidth = Math.max(1, zoom2);
        const r = Math.min(zoom4, sw * 0.08);
        drawBox(m_context, sx, sy, sw, sh, r);

        // Focused root node halo (golden glow)
        if (m_focused_node_id && ln.node.id === m_focused_node_id) {
            const light = isLightTheme();
            const halo_color = light ? '#B87800' : '#FFD700';
            m_context.save();
            if (!light) {
                m_context.shadowColor = halo_color;
                m_context.shadowBlur = Math.max(12, 20 * m_zoom);
            }
            m_context.strokeStyle = halo_color;
            m_context.lineWidth = Math.max(3, zoom4);
            drawBox(m_context, sx, sy, sw + zoom8, sh + zoom8, r + zoom4, true);
            m_context.restore();
            m_context.globalAlpha = node_alpha;
        }

        // Pinned node indicator (cyan border)
        if (ln.pinned) {
            m_context.strokeStyle = isLightTheme() ? '#00868B' : '#00CED1';
            m_context.lineWidth = Math.max(2, zoom3);
            drawBox(m_context, sx, sy, sw + zoom4, sh + zoom4, r + zoom2, true);
        }

        // Selection border
        if (ln.node.id === m_selected_node_id) {
            m_context.strokeStyle = isLightTheme() ? '#000000' : '#ffffff';
            m_context.lineWidth = Math.max(2, zoom3);
            const sel_offset = ln.pinned ? zoom8 : zoom4;
            drawBox(m_context, sx, sy, sw + sel_offset, sh + sel_offset, r + zoom2, true);
        }

        if (font_size <= min_font_size) { m_context.globalAlpha = 1; continue; }

        // Label with auto contrast
        const text_color = contrastTextColor(color);
        m_context.fillStyle = text_color;
        m_context.font = `bold ${font_size}px ${getCssVar('--vscode-font-family') || 'monospace'}`;
        m_context.textAlign = 'center';
        m_context.textBaseline = 'middle';
        m_context.fillText(ln.node.label, sx, sy);
        m_context.globalAlpha = 1;
    }
}

function drawBox(aCanvas: CanvasRenderingContext2D, aCx: number, aCy: number, aW: number, aH: number, aR: number, aStrokeOnly = false): void {
    const x = aCx - aW / 2;
    const y = aCy - aH / 2;
    aCanvas.beginPath();
    aCanvas.moveTo(x + aR, y);
    aCanvas.lineTo(x + aW - aR, y);
    aCanvas.arcTo(x + aW, y, x + aW, y + aR, aR);
    aCanvas.lineTo(x + aW, y + aH - aR);
    aCanvas.arcTo(x + aW, y + aH, x + aW - aR, y + aH, aR);
    aCanvas.lineTo(x + aR, y + aH);
    aCanvas.arcTo(x, y + aH, x, y + aH - aR, aR);
    aCanvas.lineTo(x, y + aR);
    aCanvas.arcTo(x, y, x + aR, y, aR);
    aCanvas.closePath();
    if (!aStrokeOnly) { aCanvas.fill(); }
    aCanvas.stroke();
}

// ------------------------------------------------------------
// Grid drawing
// ------------------------------------------------------------
function drawGrid(aW: number, aH: number): void {
    if (!m_context) { return; }

    const grid_world = GRID_SIZE;
    const grid_screen = grid_world * m_zoom;
    if (grid_screen < 4) { return; }

    const world_left = -m_cam_x / m_zoom;
    const world_top = -m_cam_y / m_zoom;
    const world_right = world_left + aW / m_zoom;
    const world_bottom = world_top + aH / m_zoom;

    const start_x = Math.floor(world_left / grid_world) * grid_world;
    const start_y = Math.floor(world_top / grid_world) * grid_world;

    const alpha = Math.min(0.3, grid_screen / 100);
    m_context.strokeStyle = themeEdgeColor(alpha);
    m_context.lineWidth = 1;

    m_context.beginPath();
    for (let wx = start_x; wx <= world_right; wx += grid_world) {
        const sx = m_cam_x + wx * m_zoom;
        m_context.moveTo(sx, 0);
        m_context.lineTo(sx, aH);
    }
    for (let wy = start_y; wy <= world_bottom; wy += grid_world) {
        const sy = m_cam_y + wy * m_zoom;
        m_context.moveTo(0, sy);
        m_context.lineTo(aW, sy);
    }
    m_context.stroke();

    // Origin cross
    const ox = m_cam_x;
    const oy = m_cam_y;
    m_context.strokeStyle = themeEdgeColor(0.5);
    m_context.lineWidth = 2;
    if (ox >= 0 && ox <= aW) {
        m_context.beginPath(); m_context.moveTo(ox, 0); m_context.lineTo(ox, aH); m_context.stroke();
    }
    if (oy >= 0 && oy <= aH) {
        m_context.beginPath(); m_context.moveTo(0, oy); m_context.lineTo(aW, oy); m_context.stroke();
    }
}

// ------------------------------------------------------------
// Minimap
// ------------------------------------------------------------
const MINIMAP_W = 150;
const MINIMAP_H = 100;
const MINIMAP_MARGIN = 8;

// Cached minimap transform for mouse interaction
let minimap_transform: {
    mx: number; my: number; // minimap top-left in canvas space
    scale: number;
    wMinX: number; wMinY: number;
    canvasW: number; canvasH: number;
} | null = null;
let is_dragging_minimap = false;

function drawMinimap(aCanvasW: number, aCanvasH: number): void {
    if (!m_context || m_layout_nodes.length === 0) { return; }

    // Compute bounding box of all visible nodes
    let min_x = Infinity, min_y = Infinity, max_x = -Infinity, max_y = -Infinity;
    let count = 0;
    for (const ln of m_layout_nodes) {
        if (isNodeFiltered(ln.node)) { continue; }
        min_x = Math.min(min_x, ln.x - ln.w / 2);
        max_x = Math.max(max_x, ln.x + ln.w / 2);
        min_y = Math.min(min_y, ln.y - NODE_H / 2);
        max_y = Math.max(max_y, ln.y + NODE_H / 2);
        count++;
    }
    if (count === 0) { return; }

    const world_w = max_x - min_x || 1;
    const world_h = max_y - min_y || 1;

    // Add some padding to the world bounds
    const pad = Math.max(world_w, world_h) * 0.05;
    const w_min_x = min_x - pad;
    const w_min_y = min_y - pad;
    const w_w = world_w + pad * 2;
    const w_h = world_h + pad * 2;

    // Minimap position (bottom-left)
    const mmx = MINIMAP_MARGIN;
    const mmy = aCanvasH - MINIMAP_H - MINIMAP_MARGIN;

    // Scale factor: fit the entire graph world into the minimap
    const scale_x = MINIMAP_W / w_w;
    const scale_y = MINIMAP_H / w_h;
    const scale = Math.min(scale_x, scale_y);

    // Save transform for mouse interaction
    minimap_transform = { mx: mmx, my: mmy, scale, wMinX: w_min_x, wMinY: w_min_y, canvasW: aCanvasW, canvasH: aCanvasH };

    // Background
    const mm_bg = getCssVar('--vscode-sideBar-background') || getCssVar('--vscode-editor-background') || '#1e1e1e';
    m_context.fillStyle = mm_bg;
    m_context.globalAlpha = 0.9;
    m_context.fillRect(mmx, mmy, MINIMAP_W, MINIMAP_H);
    m_context.globalAlpha = 1;
    m_context.strokeStyle = getCssVar('--vscode-panel-border') || 'rgba(128, 128, 128, 0.5)';
    m_context.lineWidth = 1;
    m_context.strokeRect(mmx, mmy, MINIMAP_W, MINIMAP_H);

    // Draw edges as thin lines
    m_context.strokeStyle = themeEdgeColor(0.15);
    m_context.lineWidth = 0.5;
    const node_map = new Map<string, LayoutNode>();
    for (const ln of m_layout_nodes) {
        if (!isNodeFiltered(ln.node)) {
            node_map.set(ln.node.id, ln);
        }
    }
    const has_search = m_search_filter.length > 0;
    for (const edge of m_all_edges) {
        const from_ln = node_map.get(edge.from);
        const to_ln = node_map.get(edge.to);
        if (!from_ln || !to_ln) { continue; }
        const ex1 = mmx + (from_ln.x - w_min_x) * scale;
        const ey1 = mmy + (from_ln.y - w_min_y) * scale;
        const ex2 = mmx + (to_ln.x - w_min_x) * scale;
        const ey2 = mmy + (to_ln.y - w_min_y) * scale;
        m_context.beginPath();
        m_context.moveTo(ex1, ey1);
        m_context.lineTo(ex2, ey2);
        m_context.stroke();
    }

    // Draw nodes as small dots (reflecting search/focus dim)
    for (const ln of m_layout_nodes) {
        if (isNodeFiltered(ln.node)) { continue; }
        // In "dim" mode, reduce opacity for non-matching nodes
        const matches_search = !has_search || nodeMatchesSearch(ln.node);
        const in_focus = isNodeVisibleInFocus(ln.node.id);
        const is_dimmed = !matches_search || !in_focus;
        const nx = mmx + (ln.x - w_min_x) * scale;
        const ny = mmy + (ln.y - w_min_y) * scale;
        const dot_size = Math.max(2, ln.w * scale * 0.3);
        m_context.globalAlpha = is_dimmed ? 0.15 : 1;
        m_context.fillStyle = ln.node.id === m_selected_node_id ? themeFg() : ln.node.color;
        m_context.fillRect(nx - dot_size / 2, ny - dot_size / 2, dot_size, dot_size);
    }
    m_context.globalAlpha = 1;

    // Draw viewport rectangle
    const view_world_left = -m_cam_x / m_zoom;
    const view_world_top = -m_cam_y / m_zoom;
    const view_world_right = view_world_left + aCanvasW / m_zoom;
    const view_world_bottom = view_world_top + aCanvasH / m_zoom;

    const vx = mmx + (view_world_left - w_min_x) * scale;
    const vy = mmy + (view_world_top - w_min_y) * scale;
    const vw = (view_world_right - view_world_left) * scale;
    const vh = (view_world_bottom - view_world_top) * scale;

    m_context.strokeStyle = 'rgba(255, 200, 50, 0.8)';
    m_context.lineWidth = 1.5;
    // Clip the viewport rectangle to minimap bounds
    const clip_x = Math.max(mmx, vx);
    const clip_y = Math.max(mmy, vy);
    const clip_r = Math.min(mmx + MINIMAP_W, vx + vw);
    const clip_b = Math.min(mmy + MINIMAP_H, vy + vh);
    if (clip_r > clip_x && clip_b > clip_y) {
        m_context.strokeRect(clip_x, clip_y, clip_r - clip_x, clip_b - clip_y);
    }
}

/** Check if a screen point falls within the minimap bounds */
function isInMinimap(aSx: number, aSy: number): boolean {
    if (!m_minimap_enabled || !minimap_transform) { return false; }
    const { mx, my } = minimap_transform;
    return aSx >= mx && aSx <= mx + MINIMAP_W && aSy >= my && aSy <= my + MINIMAP_H;
}

/** Convert minimap screen coords to world coords, then center the camera there */
function minimapPanTo(aSx: number, aSy: number): void {
    if (!minimap_transform || !m_canvas) { return; }
    const { mx, my, scale, wMinX, wMinY } = minimap_transform;
    // Convert minimap position to world coords
    const world_x = (aSx - mx) / scale + wMinX;
    const world_y = (aSy - my) / scale + wMinY;
    // Center the camera on this world position
    m_cam_x = m_canvas.clientWidth / 2 - world_x * m_zoom;
    m_cam_y = m_canvas.clientHeight / 2 - world_y * m_zoom;
    saveState();
    draw();
}

// ------------------------------------------------------------
// Hit testing
// ------------------------------------------------------------

function hitTestNode(aPosX: number, aPosY: number): LayoutNode | null {
    for (let i = m_layout_nodes.length - 1; i >= 0; i--) {
        const ln = m_layout_nodes[i];
        if (isNodeFiltered(ln.node)) { continue; }
        const [sx, sy] = worldToScreen(ln.x, ln.y);
        const hw = (ln.w * m_zoom) / 2;
        const hh = (NODE_H * m_zoom) / 2;
        if (aPosX >= sx - hw && aPosX <= sx + hw && aPosY >= sy - hh && aPosY <= sy + hh) {
            return ln;
        }
    }
    return null;
}

// ------------------------------------------------------------
// Canvas events: pan, node drag, zoom, selection
// ------------------------------------------------------------

function attachCanvasEvents(aCanvas: HTMLCanvasElement): void {
    aCanvas.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === ' ') { e.preventDefault(); }
    });
    aCanvas.addEventListener('keyup', (e: KeyboardEvent) => {
        if (e.key === ' ') {
            e.preventDefault();
            startStopSimulation();
        }
    });

    aCanvas.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0) { return; }
        e.preventDefault();
        aCanvas.focus();

        const rect = aCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Check minimap first -- capture events there
        if (isInMinimap(mx, my)) {
            is_dragging_minimap = true;
            minimapPanTo(mx, my);
            aCanvas.style.cursor = 'crosshair';
            return;
        }

        const hit = hitTestNode(mx, my);
        if (hit) {
            m_is_dragging_node = true;
            m_drag_node = hit;
            m_selected_node_id = hit.node.id;
            updateFooter();
            const [sx, sy] = worldToScreen(hit.x, hit.y);
            m_drag_offset_x = mx - sx;
            m_drag_offset_y = my - sy;
            aCanvas.style.cursor = 'move';
            // Auto-pause: pause sim while dragging
            if (m_auto_pause_during_drag && m_sim_running) {
                stopSimulation();
            }
            if (hit.node.type !== 'SYSTEM_LIBRARY') {
                m_vscode.postMessage({ type: 'nodeClick', targetId: hit.node.id });
            }
        } else {
            m_is_panning = true;
            m_pan_start_x = e.clientX;
            m_pan_start_y = e.clientY;
            m_cam_start_x = m_cam_x;
            m_cam_start_y = m_cam_y;
            aCanvas.style.cursor = 'grabbing';
        }
        draw();
    });

    window.addEventListener('mousemove', (e: MouseEvent) => {
        window.focus();
        if (is_dragging_minimap) {
            const rect = aCanvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            minimapPanTo(mx, my);
            return;
        }
        if (m_is_dragging_node && m_drag_node) {
            const rect = aCanvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            m_drag_node.x = (mx - m_drag_offset_x - m_cam_x) / m_zoom;
            m_drag_node.y = (my - m_drag_offset_y - m_cam_y) / m_zoom;
            draw();
        } else if (m_is_panning) {
            m_was_panning = true;
            m_cam_x = m_cam_start_x + (e.clientX - m_pan_start_x);
            m_cam_y = m_cam_start_y + (e.clientY - m_pan_start_y);
            draw();
        }
    });

    window.addEventListener('mouseup', (e: MouseEvent) => {
        if (e.button !== 0) { return; }
        if (is_dragging_minimap) {
            is_dragging_minimap = false;
            aCanvas.style.cursor = 'grab';
            return;
        }
        if (m_is_dragging_node) {
            m_is_dragging_node = false;
            m_drag_node = null;
            aCanvas.style.cursor = 'grab';
            // Resume sim if enabled (auto-pause or normal mode)
            if (m_sim_enabled) {
                startSimulation();
            }
        } else if (!m_was_panning && e.target === aCanvas) {
            // Deselect only when clicking on the canvas, not on footer/header/other UI
            m_selected_node_id = null;
            updateFooter();
            draw();
        }
        if (m_is_panning) {
            m_is_panning = false;
            m_was_panning = false;
            aCanvas.style.cursor = 'grab';
            saveState();
        }
    });

    aCanvas.addEventListener('click', (e: MouseEvent) => {
        window.focus();
    });

    aCanvas.addEventListener('dblclick', (e: MouseEvent) => {
        window.focus();
        const rect = aCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        // Ignore double-click on minimap
        if (isInMinimap(mx, my)) { return; }
        // Use selected_node_id from mousedown instead of re-hit-testing,
        // because the node may have moved slightly during the drag between clicks
        if (m_selected_node_id) {
            if (m_selected_node_id === m_focused_node_id) {
                // Already focused -- just re-center gravity origin on this node
                shiftOriginToNode(m_selected_node_id);
                restartSimIfEnabled();
                draw();
                return;
            }
            // Ctrl+double-click: open subgraph as fresh root (reset breadcrumb)
            if (e.ctrlKey || e.metaKey) {
                exitFocusView();
                focusOnNode(m_selected_node_id);
            } else {
                // Normal double-click: drill down (append to breadcrumb)
                focusOnNode(m_selected_node_id);
            }
        } else {
            // Double-click on background: fit graph to view
            centerOnNodes();
            draw();
        }
    });

    aCanvas.addEventListener('wheel', (e: WheelEvent) => {
        e.preventDefault();
        window.focus();
        const rect = aCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Zoom from minimap: zoom centered on the minimap world position
        if (isInMinimap(mx, my) && minimap_transform) {
            const world_x = (mx - minimap_transform.mx) / minimap_transform.scale + minimap_transform.wMinX;
            const world_y = (my - minimap_transform.my) / minimap_transform.scale + minimap_transform.wMinY;
            const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            m_zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, m_zoom * factor));
            m_cam_x = aCanvas.clientWidth / 2 - world_x * m_zoom;
            m_cam_y = aCanvas.clientHeight / 2 - world_y * m_zoom;
            saveState();
            draw();
            return;
        }

        const wx_before = (mx - m_cam_x) / m_zoom;
        const wy_before = (my - m_cam_y) / m_zoom;

        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        m_zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, m_zoom * factor));

        m_cam_x = mx - wx_before * m_zoom;
        m_cam_y = my - wy_before * m_zoom;

        saveState();
        draw();
    }, { passive: false });

    aCanvas.style.cursor = 'grab';
}

// ------------------------------------------------------------
// Force-directed simulation
// ------------------------------------------------------------

/** Restart simulation if it's enabled (convenience for visibility changes) */
function restartSimIfEnabled(): void {
    if (m_sim_enabled) {
        stopSimulation();
        startSimulation();
    }
}

function startSimulation(): void {
    if (m_sim_running || !m_sim_enabled) { return; }
    m_sim_running = true;
    m_sim_anim_frame = requestAnimationFrame(simulationStep);
}

function stopSimulation(): void {
    m_sim_running = false;
    if (m_sim_anim_frame !== null) {
        cancelAnimationFrame(m_sim_anim_frame);
        m_sim_anim_frame = null;
    }
    m_frame_delta_ms = 0;
    m_frame_last_time = 0;
    updatePerFrameDatas();
}

function startStopSimulation(): void {
    if (m_sim_enabled) {
        m_sim_enabled = false;
        stopSimulation();
    } else {
        m_sim_enabled = true;
        startSimulation();
    }
    updateStartStopBtn();
    m_vscode.postMessage({ type: 'updateSetting', key: 'graphSimEnabled', value: m_sim_enabled });
}

let m_nodesCount: number;
let m_forcesX: Float64Array;
let m_forcesY: Float64Array;
const m_node_index = new Map<string, number>();
const m_adjacency = new Map<string, Set<string>>(); // node id -> set of adjacent node ids
const m_degree = new Map<string, number>();// node id -> degree (number of connections)

// Build adjacency set and degree count for connectivity-aware repulsion
// This allows us to apply stronger repulsion between unconnected nodes, 
// especially high-degree ones, to reduce clutter around hubs and improve overall layout clarity
function m_computeAdjancency(): void {
    m_node_index.clear();

    // Build index
    m_layout_nodes.forEach((ln, i) => m_node_index.set(ln.node.id, i));

    m_nodesCount = m_layout_nodes.length;
    m_forcesX = new Float64Array(m_nodesCount);
    m_forcesY = new Float64Array(m_nodesCount);

    const adjacency = new Map<string, Set<string>>(); // node id -> set of adjacent node ids
    const degree = new Map<string, number>();// node id -> degree (number of connections)
    for (const edge of m_all_edges) {
        // Ensure both nodes are in the adjacency map
        if (!adjacency.has(edge.from)) { adjacency.set(edge.from, new Set()); }
        // Ensure both nodes are in the adjacency map
        if (!adjacency.has(edge.to)) { adjacency.set(edge.to, new Set()); }
        adjacency.get(edge.from)!.add(edge.to);
        adjacency.get(edge.to)!.add(edge.from);
    }
    // Compute degree for each node
    for (let i = 0; i < m_nodesCount; i++) {
        degree.set(m_layout_nodes[i].node.id, adjacency.get(m_layout_nodes[i].node.id)?.size ?? 0);
    }
    // calcul of node mass based on degree (for inertia in the simulation)
    for (let i = 0; i < m_nodesCount; i++) {
        const id = m_layout_nodes[i].node.id;
        const deg = adjacency.get(id)?.size ?? 0;
        // Base mass of 1, plus 0.5 per connection, to give more inertia to highly connected nodes
        m_layout_nodes[i].mass = 1 + deg * 0.5;
    }
}

// Repulsion between all pairs (Coulomb) -- stronger for unconnected high-degree nodes
function m_repulseNodes(): void {
    for (let i = 0; i < m_nodesCount; i++) {
        // Skip filtered nodes
        if (isNodeFiltered(m_layout_nodes[i].node)) { continue; }
        const id_i = m_layout_nodes[i].node.id;
        const deg_i = m_degree.get(id_i) ?? 0;
        const adj_i = m_adjacency.get(id_i);
        for (let j = i + 1; j < m_nodesCount; j++) {
            if (isNodeFiltered(m_layout_nodes[j].node)) { continue; }
            const id_j = m_layout_nodes[j].node.id;
            // Check if nodes are directly connected
            const connected = adj_i !== undefined && adj_i.has(id_j);
            let dx = m_layout_nodes[j].x - m_layout_nodes[i].x;
            let dy = m_layout_nodes[j].y - m_layout_nodes[i].y;
            const dist_sq = dx * dx + dy * dy;
            let dist = Math.sqrt(dist_sq);
            // Avoid division by zero
            if (dist < 0.1) {
                dx = (Math.random() - 0.5) * 2;
                dy = (Math.random() - 0.5) * 2;
                dist = 1;
            }
            // Standard repulsion
            let force = m_sim_vars.repulsion / (dist * dist);
            // Extra push when closer than minDistance
            if (dist < m_sim_vars.minDistance) {
                force *= (m_sim_vars.minDistance / dist);
            }
            // Boost repulsion for unconnected nodes based on their degree
            // High-degree nodes push harder to reduce clutter around hubs
            if (!connected) {
                const deg_j = m_degree.get(id_j) ?? 0;
                const deg_boost = 1 + 0.15 * (deg_i + deg_j);
                force *= deg_boost;
            }
            const force_x = (dx / dist) * force;
            const force_y = (dy / dist) * force;
            m_forcesX[i] -= force_x;
            m_forcesY[i] -= force_y;
            m_forcesX[j] += force_x;
            m_forcesY[j] += force_y;
        }
    }
}

// Attraction on edges (Hooke)
function m_attractLinks(): void {
    for (const edge of m_all_edges) {
        const fi = m_node_index.get(edge.from);
        const ti = m_node_index.get(edge.to);
        if (fi === undefined || ti === undefined) { continue; }
        if (isNodeFiltered(m_layout_nodes[fi].node)) { continue; }
        if (isNodeFiltered(m_layout_nodes[ti].node)) { continue; }
        const dx = m_layout_nodes[ti].x - m_layout_nodes[fi].x;
        const dy = m_layout_nodes[ti].y - m_layout_nodes[fi].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) { continue; }
        // linear spring: F = k * x
        //const force = sim_vars.attraction * dist;
        // Logarithmic spring: strong pull when far, weaker when close
        const force = m_sim_vars.attraction * Math.log(2 + dist) / m_sim_vars.linkLength;
        const force_x = (dx / dist) * force;
        const force_y = (dy / dist) * force;
        m_forcesX[fi] += force_x;
        m_forcesY[fi] += force_y;
        m_forcesX[ti] -= force_x;
        m_forcesY[ti] -= force_y;
    }
}

// Central gravity toward origin
function m_centralGravity(): void {
    for (let i = 0; i < m_nodesCount; i++) {
        if (isNodeFiltered(m_layout_nodes[i].node)) { continue; }
        const px = m_layout_nodes[i].x;
        const py = m_layout_nodes[i].y;
        const dist = Math.sqrt(px * px + py * py);
        if (dist < 1) { continue; }
        const force_dist = m_sim_vars.gravity; // * Math.pow(dist, 0.25) ;
        m_forcesX[i] -= px * force_dist;
        m_forcesY[i] -= py * force_dist;
    }
}

// Dynamic barycenter: apply a force towards the current center of mass of the system
function m_dynamicBarycenter(): void {
    let totalMass = 0;
    let centerX = 0;
    let centerY = 0;

    // 1. Calculer le centre de masse actuel
    for (let i = 0; i < m_nodesCount; i++) {
        const ln = m_layout_nodes[i];
        const m = ln.mass || 1;
        centerX += ln.x * m;
        centerY += ln.y * m;
        totalMass += m;
    }
    centerX /= totalMass;
    centerY /= totalMass;

    // 2. Appliquer une force de rappel vers le centre de l'écran (0,0)
    // Mais on l'applique plus faiblement aux masses lourdes (Inertie)
    for (let i = 0; i < m_nodesCount; i++) {
        const ln = m_layout_nodes[i];
        const dx = centerX - ln.x; // On peut aussi tirer vers (0 - ln.x)
        const dy = centerY - ln.y;

        // Force de rappel vers l'origine pondérée par la masse
        m_forcesX[i] -= (ln.x) * m_sim_vars.gravity * 0.1;
        m_forcesY[i] -= (ln.y) * m_sim_vars.gravity * 0.1;
    }
}

// Apply forces with velocity damping
function m_applyForces(): void {
    const max_speed = 20;
    for (let i = 0; i < m_nodesCount; i++) {
        if (isNodeFiltered(m_layout_nodes[i].node)) { continue; }
        // Don't move the node being dragged
        if (m_is_dragging_node && m_drag_node === m_layout_nodes[i]) { continue; }
        // Don't move pinned nodes (simulation forces ignored)
        if (m_layout_nodes[i].pinned) { continue; }

        const ln = m_layout_nodes[i];
        const m = ln.mass || 1;

        // Accélération = Force / Masse
        const ax = m_forcesX[i] / m;
        const ay = m_forcesY[i] / m;

        // Application de l'accélération à la vélocité avec damping
        ln.vx = (ln.vx + ax) * m_sim_vars.damping;
        ln.vy = (ln.vy + ay) * m_sim_vars.damping;

        // const ln = m_layout_nodes[i];
        // ln.vx = (ln.vx + m_forcesX[i]) * m_sim_vars.damping;
        // ln.vy = (ln.vy + m_forcesY[i]) * m_sim_vars.damping;

        // Clamp speed
        const speed = Math.sqrt(ln.vx * ln.vx + ln.vy * ln.vy);
        if (speed > max_speed) {
            ln.vx = (ln.vx / speed) * max_speed;
            ln.vy = (ln.vy / speed) * max_speed;
        }

        ln.x += ln.vx;
        ln.y += ln.vy;
        m_total_sim_energy += Math.abs(ln.vx) + Math.abs(ln.vy);
    }
}

function simulationStep(): void {
    if (!m_sim_running) { return; }

    // Frame delta
    const now = performance.now();
    if (m_frame_last_time > 0) {
        m_frame_delta_ms = now - m_frame_last_time;
    }
    m_frame_last_time = now;

    for (let step = 0; step < m_sim_vars.stepsPerFrame; step++) {
        m_total_sim_energy = 0;

        m_computeAdjancency();
        m_repulseNodes();
        m_attractLinks();
        //m_centralGravity();
        m_dynamicBarycenter();
        m_applyForces();

        // Check equilibrium
        if (m_total_sim_energy < m_sim_vars.threshold) {
            stopSimulation();
            draw();
            return;
        } else {
            updateFooter();
        }
    }

    draw();
    m_sim_anim_frame = requestAnimationFrame(simulationStep);
}

// ------------------------------------------------------------
// Resize handling
// ------------------------------------------------------------
let resize_timer: ReturnType<typeof setTimeout> | null = null;

function onResize(): void {
    if (resize_timer) { clearTimeout(resize_timer); }
    resize_timer = setTimeout(() => {
        recalcContainerHeight();
        resizeCanvas();
    }, 50);
}

function recalcContainerHeight(): void {
    const container = document.getElementById('graph-container')!;
    const toolbar_h = document.getElementById('toolbar')?.offsetHeight ?? 0;
    const footer_h = document.getElementById('footer')?.offsetHeight ?? 0;
    const breadcrumb_h = document.getElementById('breadcrumb-bar')?.offsetHeight ?? 0;
    const available = window.innerHeight - toolbar_h - footer_h - breadcrumb_h;
    container.style.height = `${Math.max(200, available)}px`;
}

window.addEventListener('resize', onResize);
const graph_container = document.getElementById('graph-container')!;
const resize_observer = new ResizeObserver(onResize);
resize_observer.observe(graph_container);

// ------------------------------------------------------------
// Graph creation
// ------------------------------------------------------------
function createGraph(aNodes: GraphNode[], aEdges: GraphEdge[]): void {
    stopSimulation();

    // Filter out UTILITY nodes
    const filtered = aNodes.filter(n => n.type !== 'UTILITY');

    // Deduplicate by id
    const seen = new Set<string>();
    const unique: GraphNode[] = [];
    for (const n of filtered) {
        if (!seen.has(n.id)) {
            seen.add(n.id);
            unique.push(n);
        }
    }

    // Filter edges to only reference existing node ids
    const valid_ids = new Set(unique.map(n => n.id));
    m_all_edges = aEdges.filter(e => valid_ids.has(e.from) && valid_ids.has(e.to));
    m_all_nodes = unique;
    m_active_filters.clear();

    const empty_msg = document.getElementById('empty-message')!;

    initSearchBar();
    if (m_all_nodes.length === 0) {
        document.getElementById('graph-container')!.style.display = 'none';
        empty_msg.style.display = 'flex';
        empty_msg.textContent = 'No targets to display';
        buildFilterCheckboxes();
        return;
    }

    initLayoutNodes(m_all_nodes);
    buildFilterCheckboxes();
    recalcContainerHeight();

    setTimeout(() => {
        setupCanvas();
        if (m_first_layout || !restoreState()) {
            centerOnNodes();
            m_first_layout = false;
        }
        draw();
        // Start force simulation
        startSimulation();
        // Restore settings panel after container is visible
        if (m_settings_panel_visible && !settings_panel) {
            toggleSettings(false);
        }
    }, 50);
}

/** Initialize layout nodes: preserve existing positions, new nodes in a circle */
function initLayoutNodes(aNodes: GraphNode[]): void {
    const existing_positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();
    for (const ln of m_layout_nodes) {
        existing_positions.set(ln.node.id, { x: ln.x, y: ln.y, vx: ln.vx, vy: ln.vy });
    }

    const widths = aNodes.map(n => measureNodeWidth(n.label));

    m_layout_nodes = [];
    const radius = Math.max(100, aNodes.length * 10);

    for (let i = 0; i < aNodes.length; i++) {
        const n = aNodes[i];
        const w = widths[i];
        const existing = existing_positions.get(n.id);
        if (existing) {
            m_layout_nodes.push({ node: n, x: existing.x, y: existing.y, w, vx: existing.vx, vy: existing.vy, mass: 1, pinned: false });
        } else {
            const angle = (2 * Math.PI * i) / aNodes.length;
            m_layout_nodes.push({
                node: n,
                x: Math.cos(angle) * radius,
                y: Math.sin(angle) * radius,
                w,
                vx: 0,
                vy: 0,
                mass: 1,
                pinned: false,
            });
        }
    }
}

/** Reset all node positions to initial circle and restart simulation */
function resetLayoutPositions(): void {
    stopSimulation();
    const radius = Math.max(150, m_layout_nodes.length * 20);
    for (let i = 0; i < m_layout_nodes.length; i++) {
        const angle = (2 * Math.PI * i) / m_layout_nodes.length;
        m_layout_nodes[i].x = Math.cos(angle) * radius;
        m_layout_nodes[i].y = Math.sin(angle) * radius;
        m_layout_nodes[i].vx = 0;
        m_layout_nodes[i].vy = 0;
    }
    draw();
    startSimulation();
}

function centerOnNodes(): void {
    if (!m_canvas || m_layout_nodes.length === 0) { return; }
    let min_x = Infinity, min_y = Infinity, max_x = -Infinity, max_y = -Infinity;
    let count = 0;
    for (const ln of m_layout_nodes) {
        if (isNodeFiltered(ln.node)) { continue; }
        min_x = Math.min(min_x, ln.x - ln.w / 2);
        max_x = Math.max(max_x, ln.x + ln.w / 2);
        min_y = Math.min(min_y, ln.y - NODE_H / 2);
        max_y = Math.max(max_y, ln.y + NODE_H / 2);
        count++;
    }
    if (count === 0) { return; }
    const bw = max_x - min_x;
    const bh = max_y - min_y;
    const cw = m_canvas.clientWidth;
    const ch = m_canvas.clientHeight;

    const pad = 40;
    m_zoom = Math.min((cw - pad * 2) / Math.max(1, bw), (ch - pad * 2) / Math.max(1, bh), 2);
    m_zoom = Math.max(ZOOM_MIN, m_zoom);

    const center_wx = (min_x + max_x) / 2;
    const center_wy = (min_y + max_y) / 2;
    m_cam_x = cw / 2 - center_wx * m_zoom;
    m_cam_y = ch / 2 - center_wy * m_zoom;

    saveState();
}

// ------------------------------------------------------------
// Search bar (lives inside #breadcrumb-bar, always visible)
// ------------------------------------------------------------
let search_bar_inited = false;
function initSearchBar(): void {
    if (search_bar_inited) { return; }
    search_bar_inited = true;

    // Build the help button + search controls + edge direction inside the breadcrumb bar
    const bar = document.getElementById('breadcrumb-bar')!;
    bar.innerHTML = buildHelpButtonHtml() + buildSearchControlsHtml() +
        '<span class="breadcrumb-separator">\u2502</span>' + buildEdgeDirectionHtml();
    attachSearchEvents();
    attachEdgeDirectionEvents();
}

function buildHelpButtonHtml(): string {
    const lines = [
        'Click \u2014 Select node',
        'Double-click node \u2014 Focus subgraph (drill down)',
        'Ctrl+Double-click \u2014 Focus subgraph (fresh root)',
        'Double-click background \u2014 Fit to view',
        'Scroll \u2014 Zoom',
        'Drag node \u2014 Move node',
        'Drag background \u2014 Pan',
    ];
    const tip = lines.join('&#10;');
    return `<button id="help-btn" title="${tip}">?</button>`;
}

function buildSearchControlsHtml(): string {
    const filter_icon = m_search_filter_mode === 'dim' ? '\u{1F441}' : '\u{1F6AB}';
    const filter_title = m_search_filter_mode === 'dim'
        ? 'Mode: Dim non-matching (click to switch to Hide)'
        : 'Mode: Hide non-matching (click to switch to Dim)';
    const mode_label = m_search_mode === 'name' ? 'N' : 'P';
    const mode_title = m_search_mode === 'name'
        ? 'Filtering by name (click to switch to path)'
        : 'Filtering by path (click to switch to name)';
    const placeholder = m_search_mode === 'name' ? 'Filter by name\u2026' : 'Filter by path\u2026';
    return `<div id="search-container">` +
        `<button id="search-filter-mode" title="${filter_title}">${filter_icon}</button>` +
        `<button id="search-mode" title="${mode_title}">${mode_label}</button>` +
        `<input id="search-input" type="text" placeholder="${placeholder}" spellcheck="false" value="${escapeHtml(m_search_filter)}">` +
        `<button id="search-clear" title="Clear filter">\u2715</button>` +
        `</div>`;
}

function attachSearchEvents(): void {
    const input = document.getElementById('search-input') as HTMLInputElement;
    const mode_btn = document.getElementById('search-mode') as HTMLButtonElement;
    const filter_mode_btn = document.getElementById('search-filter-mode') as HTMLButtonElement;
    const clear_btn = document.getElementById('search-clear') as HTMLButtonElement;
    if (!input || !mode_btn || !clear_btn || !filter_mode_btn) { return; }

    mode_btn.addEventListener('click', () => {
        m_search_mode = m_search_mode === 'name' ? 'path' : 'name';
        input.placeholder = m_search_mode === 'name' ? 'Filter by name\u2026' : 'Filter by path\u2026';
        mode_btn.textContent = m_search_mode === 'name' ? 'N' : 'P';
        mode_btn.title = m_search_mode === 'name' ? 'Filtering by name (click to switch to path)' : 'Filtering by path (click to switch to name)';
        applySearchFilter();
    });

    filter_mode_btn.addEventListener('click', () => {
        m_search_filter_mode = m_search_filter_mode === 'dim' ? 'hide' : 'dim';
        filter_mode_btn.textContent = m_search_filter_mode === 'dim' ? '\u{1F441}' : '\u{1F6AB}';
        filter_mode_btn.title = m_search_filter_mode === 'dim'
            ? 'Mode: Dim non-matching (click to switch to Hide)'
            : 'Mode: Hide non-matching (click to switch to Dim)';
        applySearchFilter();
    });

    clear_btn.addEventListener('click', () => {
        m_search_filter = '';
        input.value = '';
        applySearchFilter();
    });

    input.addEventListener('input', () => {
        m_search_filter = input.value;
        applySearchFilter();
    });
}

function applySearchFilter(): void {
    // In hide mode, filtered nodes are excluded from simulation, so restart it
    if (m_search_filter_mode === 'hide') {
        restartSimIfEnabled();
    }
    draw();
}

// ------------------------------------------------------------
// Type filters
// ------------------------------------------------------------
function buildFilterCheckboxes(): void {
    const container = document.getElementById('filters')!;
    container.innerHTML = '';

    // Count only nodes visible in the current focus view (or all nodes if not focused)
    const type_counts = new Map<string, number>();
    for (const n of m_all_nodes) {
        if (m_focus_visible_ids && !m_focus_visible_ids.has(n.id)) { continue; }
        type_counts.set(n.type, (type_counts.get(n.type) ?? 0) + 1);
    }

    for (const type of TARGET_TYPES) {
        const count = type_counts.get(type) ?? 0;
        if (count === 0) { continue; }

        const label = document.createElement('label');
        label.className = 'filter-label';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !m_active_filters.has(type);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                m_active_filters.delete(type);
            } else {
                m_active_filters.add(type);
            }
            restartSimIfEnabled();
            draw();
        });

        const span = document.createElement('span');
        const node_of_type = m_all_nodes.find(n => n.type === type);
        span.textContent = ` ${type} (${count})`;
        span.style.color = node_of_type?.color ?? (getCssVar('--vscode-descriptionForeground') || '#888');

        label.appendChild(checkbox);
        label.appendChild(span);
        container.appendChild(label);
    }
}

// ------------------------------------------------------------
// Settings panel
// ------------------------------------------------------------
let settings_panel: HTMLDivElement | null = null;

function toggleSettings(aPersist = true): void {
    if (settings_panel) {
        settings_panel.remove();
        settings_panel = null;
        if (aPersist) { m_vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsVisible', value: false }); }
        return;
    }
    settings_panel = document.createElement('div');
    settings_panel.id = 'settings-panel';
    settings_panel.innerHTML = buildSettingsHtml();
    // Place inside graph-container as absolute overlay on the right side
    const container = document.getElementById('graph-container')!;
    container.appendChild(settings_panel);
    attachSettingsEvents();
    if (aPersist) { m_vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsVisible', value: true }); }
}

function resetBtn(aDefaultKey: string): string {
    return `<button class="settings-reset-btn" data-defkey="${aDefaultKey}" title="Reset to default value">\u21B6</button>`;
}

function inputRow(aId: string, aLabel: string, aSimKey: keyof SimVars, aValue: number, aDefaultKey: string): string {
    const [lo, hi] = SIM_CLAMP[aSimKey];
    return `<div class="settings-row-inline">
        <label>${aLabel}</label>
        <div class="settings-input-row">
            <input type="number" id="s-${aId}" min="${lo}" max="${hi}" value="${aValue}" data-simkey="${aSimKey}">
            ${resetBtn(aDefaultKey)}
        </div>
    </div>`;
}

// ------------------------------------------------------------
// Footer (always visible, shows selected node info)
// ------------------------------------------------------------
let m_footer_node_id: string | null = null; // tracks which node the footer is showing

function updatePerFrameDatas(): void {
    const energy_el = document.getElementById('f-energy');
    if (energy_el) {
        energy_el.textContent = m_total_sim_energy.toFixed(2);
    }
    const delta_el = document.getElementById('f-delta');
    if (delta_el) {
        delta_el.textContent = m_frame_delta_ms > 0 ? m_frame_delta_ms.toFixed(1) : 'paused';
    }
}

function updateFooter(): void {
    const footer = document.getElementById('footer')!;

    // Fast path: only update per frame datas if the selected node hasn't changed
    if (m_footer_loaded && (m_footer_node_id === m_selected_node_id)) {
        updatePerFrameDatas();
        return;
    }

    // Full rebuild needed (selection changed)
    m_footer_node_id = m_selected_node_id;
    let html =
        `<span><span class="info-label">Delta:</span> <span id="f-delta" class="info-value">${m_frame_delta_ms > 0 ? m_frame_delta_ms.toFixed(1) : '—'}</span> <span class="info-label">ms</span></span>` +
        `<span><span class="info-label">Energy:</span> <span id="f-energy" class="info-value">${m_total_sim_energy.toFixed(2)}</span></span>`;

    if (!m_selected_node_id) {
        footer.innerHTML = html;
        return;
    }
    const ln = m_layout_nodes.find(l => l.node.id === m_selected_node_id);
    if (!ln) {
        footer.innerHTML = html;
        return;
    }
    const n = ln.node;
    html +=
        `<span><span class="info-type-swatch" style="background:${n.color}"></span><span class="info-value">${escapeHtml(n.label)}</span></span>` +
        `<span><span class="info-label">Type:</span> <span class="info-value">${escapeHtml(n.type)}</span></span>` +
        `<span><span class="info-label">Path:</span> <span class="info-value" title="${escapeHtml(n.sourcePath)}">${escapeHtml(n.sourcePath)}</span></span>` +
        `<span class="footer-right"><label class="settings-checkbox"><input type="checkbox" id="f-pin"${ln.pinned ? ' checked' : ''}> Frozen</label></span>`;
    footer.innerHTML = html;

    footer.querySelector('#f-pin')!.addEventListener('change', () => {
        const cb = footer.querySelector('#f-pin') as HTMLInputElement;
        ln.pinned = cb.checked;
        if (ln.pinned) {
            ln.vx = 0;
            ln.vy = 0;
        }
    });

    m_footer_loaded = true;
}

function escapeHtml(aS: string): string {
    return aS.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ------------------------------------------------------------
// Focused view with breadcrumb navigation
// ------------------------------------------------------------

/**
 * BFS from a root node following the current edge direction.
 * Returns a Map<nodeId, depth> where depth is the BFS distance from root.
 *
 * Edges: { from: target, to: dependency_it_uses }.
 * - child-to-parent (default): follow from -> to (A uses B, go to B's deps)
 * - parent-to-child: follow to -> from (descend to consumers/children)
 */
function buildConnectedSubgraph(aRootId: string): Map<string, number> {
    const depths = new Map<string, number>();
    const queue: [string, number][] = [[aRootId, 0]];

    // Build directed adjacency based on current edge direction
    const adj = new Map<string, string[]>();
    for (const edge of m_all_edges) {
        if (m_edge_direction === EdgeDirection.USED_BY) {
            if (!adj.has(edge.from)) { adj.set(edge.from, []); }
            adj.get(edge.from)!.push(edge.to);
        } else {
            if (!adj.has(edge.to)) { adj.set(edge.to, []); }
            adj.get(edge.to)!.push(edge.from);
        }
    }

    while (queue.length > 0) {
        const [current, depth] = queue.shift()!;
        if (depths.has(current)) { continue; }
        depths.set(current, depth);
        const neighbors = adj.get(current);
        if (neighbors) {
            for (const nb of neighbors) {
                if (!depths.has(nb)) { queue.push([nb, depth + 1]); }
            }
        }
    }
    return depths;
}

/** Rebuild focus_visible_ids from focus_node_depths using focus_depth as threshold. */
function rebuildFocusVisibleIds(): void {
    if (!m_focus_node_depths) { m_focus_visible_ids = null; return; }
    const ids = new Set<string>();
    for (const [id, d] of m_focus_node_depths) {
        if (d <= m_focus_depth) { ids.add(id); }
    }
    m_focus_visible_ids = ids;
}

/**
 * Rebuild focus subgraph from the given node: compute depths, max depth,
 * reset depth to max, rebuild visible ids, update filter checkboxes and breadcrumb.
 * Centralises the logic shared by focusOnNode, navigateBreadcrumb and edge-direction changes.
 */
function rebuildFocusSubgraph(aNodeId: string): void {
    m_focus_node_depths = buildConnectedSubgraph(aNodeId);
    m_focus_max_depth = 0;
    for (const d of m_focus_node_depths.values()) {
        if (d > m_focus_max_depth) { m_focus_max_depth = d; }
    }
    m_focus_depth = m_focus_max_depth;
    rebuildFocusVisibleIds();
    buildFilterCheckboxes();
    updateBreadcrumb();
}

/** Refresh the current focus subgraph (e.g. after edge-direction change). No-op if not in focus mode. */
function refreshFocusSubgraph(): void {
    if (m_focused_node_id) {
        rebuildFocusSubgraph(m_focused_node_id);
    }
}

/** Shift world origin to a node's position, compensate camera so nothing visually moves. */
function shiftOriginToNode(aNodeId: string): void {
    const focus_ln = m_layout_nodes.find(ln => ln.node.id === aNodeId);
    if (!focus_ln) { return; }
    const dx = focus_ln.x;
    const dy = focus_ln.y;
    for (const ln of m_layout_nodes) {
        ln.x -= dx;
        ln.y -= dy;
    }
    m_cam_x += dx * m_zoom;
    m_cam_y += dy * m_zoom;
}

function focusOnNode(aNodeId: string): void {
    const node = m_all_nodes.find(n => n.id === aNodeId);
    if (!node) { return; }

    // Check if this node is already at the end of the history
    if (m_focus_history.length === 0 || m_focus_history[m_focus_history.length - 1].nodeId !== aNodeId) {
        m_focus_history.push({ nodeId: aNodeId, label: node.label });
    }
    m_focused_node_id = aNodeId;
    m_selected_node_id = aNodeId;

    // Build subgraph, depths, filters, breadcrumb
    rebuildFocusSubgraph(aNodeId);

    // Pin the root node and place it at (0,0).
    // Arrange visible sub-nodes in a circle around the root.
    const root_ln = m_layout_nodes.find(ln => ln.node.id === aNodeId);
    if (root_ln) {
        root_ln.pinned = true;
        root_ln.x = 0;
        root_ln.y = 0;
        root_ln.vx = 0;
        root_ln.vy = 0;
    }

    const visible_ids = m_focus_visible_ids ?? new Set<string>();
    const sub_nodes = m_layout_nodes.filter(ln => ln.node.id !== aNodeId && visible_ids.has(ln.node.id));
    const radius = Math.max(150, sub_nodes.length * 25);
    for (let i = 0; i < sub_nodes.length; i++) {
        const angle = (2 * Math.PI * i) / sub_nodes.length;
        sub_nodes[i].x = Math.cos(angle) * radius;
        sub_nodes[i].y = Math.sin(angle) * radius;
        sub_nodes[i].vx = 0;
        sub_nodes[i].vy = 0;
    }

    // Center camera on origin
    if (m_canvas) {
        m_cam_x = m_canvas.clientWidth / 2;
        m_cam_y = m_canvas.clientHeight / 2;
        m_zoom = 1;
    }

    restartSimIfEnabled();
    updateFooter();
    draw();
}

function exitFocusView(): void {
    // Unpin all nodes when exiting focus view
    for (const ln of m_layout_nodes) {
        ln.pinned = false;
    }
    m_focused_node_id = null;
    m_focus_history = [];
    m_focus_visible_ids = null;
    m_focus_node_depths = null;
    m_focus_depth = 0;
    m_focus_max_depth = 0;
    buildFilterCheckboxes();
    updateBreadcrumb();
    restartSimIfEnabled();
    draw();
}

function navigateBreadcrumb(aIndex: number): void {
    if (aIndex < 0) {
        // "All" clicked - exit focus view
        exitFocusView();
        return;
    }
    // Trim history to the clicked index
    m_focus_history = m_focus_history.slice(0, aIndex + 1);
    const entry = m_focus_history[aIndex];
    m_focused_node_id = entry.nodeId;
    m_selected_node_id = entry.nodeId;

    rebuildFocusSubgraph(entry.nodeId);
    restartSimIfEnabled();
    updateFooter();
    draw();
}

function buildDepthControlHtml(): string {
    const val = m_focus_depth >= m_focus_max_depth ? m_focus_max_depth : m_focus_depth;
    return `<div id="depth-control">` +
        `<button id="depth-dec" title="Decrease depth">\u25C0</button>` +
        `<input id="depth-input" type="number" min="1" max="${m_focus_max_depth}" value="${val}" title="Subgraph depth">` +
        `<button id="depth-inc" title="Increase depth">\u25B6</button>` +
        `<button id="depth-max" title="Show all depths">Max</button>` +
        `</div>`;
}

function attachDepthEvents(): void {
    const input = document.getElementById('depth-input') as HTMLInputElement | null;
    const dec_btn = document.getElementById('depth-dec') as HTMLButtonElement | null;
    const inc_btn = document.getElementById('depth-inc') as HTMLButtonElement | null;
    const max_btn = document.getElementById('depth-max') as HTMLButtonElement | null;
    if (!input || !dec_btn || !inc_btn || !max_btn) { return; }

    const applyDepth = (d: number) => {
        m_focus_depth = Math.max(1, Math.min(m_focus_max_depth, d));
        input.value = String(m_focus_depth);
        rebuildFocusVisibleIds();
        buildFilterCheckboxes();
        restartSimIfEnabled();
        draw();
    };

    dec_btn.addEventListener('click', () => applyDepth(m_focus_depth - 1));
    inc_btn.addEventListener('click', () => applyDepth(m_focus_depth + 1));
    max_btn.addEventListener('click', () => applyDepth(m_focus_max_depth));
    input.addEventListener('change', () => {
        const v = parseInt(input.value, 10);
        if (!isNaN(v)) { applyDepth(v); }
    });
}

function buildEdgeDirectionHtml(): string {
    return `<div id="edge-dir-control" style="display:inline-flex;align-items:center;gap:2px;">` +
        `<select id="bc-edgeDirection" title="Edge direction">` +
        `<option value="${EdgeDirection.USED_BY}"${m_edge_direction === EdgeDirection.USED_BY ? ' selected' : ''}>Used by</option>` +
        `<option value="${EdgeDirection.IS_USING}"${m_edge_direction === EdgeDirection.IS_USING ? ' selected' : ''}>Is using</option>` +
        `</select>` +
        `<button class="settings-reset-btn" id="bc-edgeDir-reset" title="Reset to default value">\u21B6</button>` +
        `</div>`;
}

function attachEdgeDirectionEvents(): void {
    const sel = document.getElementById('bc-edgeDirection') as HTMLSelectElement | null;
    const reset_btn = document.getElementById('bc-edgeDir-reset') as HTMLButtonElement | null;
    if (!sel) { return; }

    sel.addEventListener('change', () => {
        m_edge_direction = sel.value as EdgeDirection;
        m_vscode.postMessage({ type: 'updateSetting', key: 'graphEdgeDirection', value: m_edge_direction });
        refreshFocusSubgraph();
        // Sync the settings panel select if open
        const settings_sel = document.getElementById('s-edgeDirection') as HTMLSelectElement | null;
        if (settings_sel) { settings_sel.value = sel.value; }
        restartSimIfEnabled();
        draw();
    });

    if (reset_btn) {
        reset_btn.addEventListener('click', () => {
            const def_val = m_provider_defaults['edgeDirection'];
            if (def_val === undefined) { return; }
            sel.value = String(def_val);
            sel.dispatchEvent(new Event('change'));
        });
    }
}

function updateBreadcrumb(): void {
    const bar = document.getElementById('breadcrumb-bar')!;

    // Always rebuild: help + search controls + edge direction + breadcrumb items
    let html = buildHelpButtonHtml() + buildSearchControlsHtml();

    if (m_focused_node_id && m_focus_history.length > 0) {
        // Depth control
        html += '<span class="breadcrumb-separator">\u2502</span>';
        html += buildDepthControlHtml();
    }

    // Edge direction (always visible)
    html += '<span class="breadcrumb-separator">\u2502</span>';
    html += buildEdgeDirectionHtml();

    if (m_focused_node_id && m_focus_history.length > 0) {
        html += '<span class="breadcrumb-separator">\u2502</span>';

        // Breadcrumb navigation
        html += '<span class="breadcrumb-item" data-bc-index="-1">All</span>';
        for (let i = 0; i < m_focus_history.length; i++) {
            html += '<span class="breadcrumb-separator">\u203A</span>';
            if (i === m_focus_history.length - 1) {
                html += `<span class="breadcrumb-current">${escapeHtml(m_focus_history[i].label)}</span>`;
            } else {
                html += `<span class="breadcrumb-item" data-bc-index="${i}">${escapeHtml(m_focus_history[i].label)}</span>`;
            }
        }
    }

    bar.innerHTML = html;

    // Re-attach search events
    attachSearchEvents();

    // Attach edge direction events
    attachEdgeDirectionEvents();

    // Attach depth control events
    if (m_focused_node_id) { attachDepthEvents(); }

    // Attach breadcrumb click events
    bar.querySelectorAll('.breadcrumb-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt((el as HTMLElement).dataset.bcIndex!, 10);
            navigateBreadcrumb(idx);
        });
    });

    recalcContainerHeight();
}

/** Check if a node should be visible in focused view (uses precomputed set) */
function isNodeVisibleInFocus(aNodeId: string): boolean {
    if (!m_focus_visible_ids) { return true; }
    return m_focus_visible_ids.has(aNodeId);
}

function buildNodeColorPickersHtml(): string {
    const present_types = new Map<string, string>();
    for (const n of m_all_nodes) {
        if (!present_types.has(n.type)) {
            present_types.set(n.type, n.color);
        }
    }
    if (present_types.size === 0) { return ''; }
    let inner = '';
    for (const [type, color] of present_types) {
        inner += `<div class="settings-row-inline">
            <label class="settings-inline">${type}
                <input type="color" id="s-color-${type}" value="${color}">
            </label>
            <button class="settings-reset-btn" data-resetcolor="${type}" title="Reset to default color">\u21B6</button>
        </div>`;
    }
    return sectionHtml('colors', 'Node Colors', inner);
}

function sectionHtml(aId: string, aTitle: string, aContent: string): string {
    const collapsed = m_settings_collapse_state[aId] ?? false;
    const arrow = collapsed ? '\u25B6' : '\u25BC';
    const display = collapsed ? 'none' : 'flex';
    return `<div class="settings-section" data-section="${aId}">
        <div class="settings-title" data-collapse="${aId}">${arrow} ${aTitle}</div>
        <div class="settings-content" id="sc-${aId}" style="display:${display}">
            ${aContent}
        </div>
    </div>`;
}

function buildSettingsHtml(): string {
    const edges_content = `
        <div class="settings-row-inline">
            <label>Style</label>
            <select id="s-edgeStyle">
                <option value="${EdgeStyle.TAPERED}"${m_edge_style === EdgeStyle.TAPERED ? ' selected' : ''}>Tapered</option>
                <option value="${EdgeStyle.CHEVRONS}"${m_edge_style === EdgeStyle.CHEVRONS ? ' selected' : ''}>Chevrons</option>
                <option value="${EdgeStyle.LINE}"${m_edge_style === EdgeStyle.LINE ? ' selected' : ''}>Line</option>
            </select>
            ${resetBtn('edgeStyle')}
        </div>
        <div class="settings-row-inline">
            <label>Direction</label>
            <select id="s-edgeDirection">
                <option value="${EdgeDirection.USED_BY}"${m_edge_direction === EdgeDirection.USED_BY ? ' selected' : ''}>Used by</option>
                <option value="${EdgeDirection.IS_USING}"${m_edge_direction === EdgeDirection.IS_USING ? ' selected' : ''}>Is using</option>
            </select>
            ${resetBtn('edgeDirection')}
        </div>
        ${inputRow('taperedWidth', 'Tapered Width', 'taperedWidth', m_sim_vars.taperedWidth, 'taperedWidth')}`;

    const sim_content = `
        ${inputRow('repulsion', 'Repulsion', 'repulsion', m_sim_vars.repulsion, 'simRepulsion')}
        ${inputRow('attraction', 'Attraction', 'attraction', m_sim_vars.attraction, 'simAttraction')}
        ${inputRow('gravity', 'Gravity', 'gravity', m_sim_vars.gravity, 'simGravity')}
        ${inputRow('linkLength', 'Link Length', 'linkLength', m_sim_vars.linkLength, 'simLinkLength')}
        ${inputRow('minDist', 'Min Distance', 'minDistance', m_sim_vars.minDistance, 'simMinDistance')}
        ${inputRow('steps', 'Steps/Frame', 'stepsPerFrame', m_sim_vars.stepsPerFrame, 'simStepsPerFrame')}
        ${inputRow('threshold', 'Threshold', 'threshold', m_sim_vars.threshold, 'simThreshold')}
        ${inputRow('damping', 'Damping', 'damping', m_sim_vars.damping, 'simDamping')}`;

    const display_content = `
        <div class="settings-row-inline">
            <label class="settings-checkbox">
            <input type="checkbox" id="s-minimap"${m_minimap_enabled ? ' checked' : ''}> Show minimap</label>
            ${resetBtn('minimap')}
        </div>
    `;

    const controls_content = `
        <div class="settings-row-inline">
            <label class="settings-checkbox">
            <input type="checkbox" id="s-autoPause"${m_auto_pause_during_drag ? ' checked' : ''}> Pause during node dragging</label>
            ${resetBtn('autoPauseDrag')}
        </div>
        <div class="settings-row-inline">
            <label>Simulation</label>
            <button id="s-startstop" class="settings-row-inline-button">${m_sim_enabled ? '\u23F8 Stop' : '\u25B6 Start'}</button>
            ${resetBtn('simEnabled')}
        </div>
        <button id="s-restart" class="full-width-btn">\u21BA Restart Simulation</button>
    `;

    return `
<div class="settings-body">
    ${sectionHtml('controls', 'Controls', controls_content)}
    ${sectionHtml('display', 'Display', display_content)}
    ${sectionHtml('edges', 'Edges', edges_content)}
    ${sectionHtml('simulation', 'Force Simulation', sim_content)}
    ${buildNodeColorPickersHtml()}
</div>
`;
}

function updateStartStopBtn(): void {
    const btn = settings_panel?.querySelector('#s-startstop') as HTMLButtonElement | null;
    if (btn) {
        btn.textContent = m_sim_enabled ? '\u23F8 Stop' : '\u25B6 Start';
    }
}

function attachSettingsEvents(): void {
    if (!settings_panel) { return; }

    // Collapsible section toggle
    settings_panel.querySelectorAll('.settings-title[data-collapse]').forEach(el => {
        el.addEventListener('click', () => {
            const section_id = (el as HTMLElement).dataset.collapse!;
            const content = settings_panel!.querySelector(`#sc-${section_id}`) as HTMLElement | null;
            if (!content) { return; }
            const is_collapsed = content.style.display === 'none';
            content.style.display = is_collapsed ? 'flex' : 'none';
            m_settings_collapse_state[section_id] = !is_collapsed;
            (el as HTMLElement).textContent = (!is_collapsed ? '\u25B6' : '\u25BC') + ' ' + (el as HTMLElement).textContent!.substring(2);
            m_vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsCollapse', value: { ...m_settings_collapse_state } });
        });
    });

    // Input ID -> workspace setting key mapping
    const input_setting_keys: Record<string, string> = {
        's-repulsion': 'graphSimRepulsion',
        's-attraction': 'graphSimAttraction',
        's-gravity': 'graphSimGravity',
        's-linkLength': 'graphSimLinkLength',
        's-minDist': 'graphSimMinDistance',
        's-steps': 'graphSimStepsPerFrame',
        's-threshold': 'graphSimThreshold',
        's-damping': 'graphSimDamping',
        's-taperedWidth': 'graphTaperedWidth',
    };

    // Edge style
    const edge_sel = settings_panel.querySelector('#s-edgeStyle') as HTMLSelectElement;
    edge_sel.addEventListener('change', () => {
        m_edge_style = edge_sel.value as EdgeStyle;
        m_vscode.postMessage({ type: 'updateSetting', key: 'graphEdgeStyle', value: m_edge_style });
        draw();
    });

    // Edge direction
    const dir_sel = settings_panel.querySelector('#s-edgeDirection') as HTMLSelectElement;
    dir_sel.addEventListener('change', () => {
        m_edge_direction = dir_sel.value as EdgeDirection;
        m_vscode.postMessage({ type: 'updateSetting', key: 'graphEdgeDirection', value: m_edge_direction });
        // Sync breadcrumb select
        const bc_sel = document.getElementById('bc-edgeDirection') as HTMLSelectElement | null;
        if (bc_sel) { bc_sel.value = dir_sel.value; }
        refreshFocusSubgraph();
        restartSimIfEnabled();
        draw();
    });

    // Auto-pause checkbox
    const auto_pause_check = settings_panel.querySelector('#s-autoPause') as HTMLInputElement;
    auto_pause_check.addEventListener('change', () => {
        m_auto_pause_during_drag = auto_pause_check.checked;
        m_vscode.postMessage({ type: 'updateSetting', key: 'graphAutoPauseDrag', value: m_auto_pause_during_drag });
    });

    // Minimap checkbox
    const minimap_check = settings_panel.querySelector('#s-minimap') as HTMLInputElement;
    minimap_check.addEventListener('change', () => {
        m_minimap_enabled = minimap_check.checked;
        m_vscode.postMessage({ type: 'updateSetting', key: 'graphMinimap', value: m_minimap_enabled });
        draw();
    });

    // Number inputs with clamping
    settings_panel.querySelectorAll<HTMLInputElement>('input[type="number"][data-simkey]').forEach(input => {
        const sim_key = input.dataset.simkey as keyof SimVars;
        input.addEventListener('change', () => {
            const raw = parseFloat(input.value);
            if (isNaN(raw)) { input.value = String(m_sim_vars[sim_key]); return; }
            const clamped = clampSimVar(sim_key, raw);
            m_sim_vars[sim_key] = sim_key === 'stepsPerFrame' ? Math.round(clamped) : clamped;
            input.value = String(m_sim_vars[sim_key]);
            const setting_key = input_setting_keys[input.id];
            if (setting_key) {
                m_vscode.postMessage({ type: 'updateSetting', key: setting_key, value: m_sim_vars[sim_key] });
            }
            startSimulation();
        });
    });

    // Node color pickers
    const present_types = new Set(m_all_nodes.map(n => n.type));
    for (const type of present_types) {
        const picker = settings_panel?.querySelector(`#s-color-${type}`) as HTMLInputElement | null;
        if (!picker) { continue; }
        picker.addEventListener('input', () => {
            const new_color = picker.value;
            for (const n of m_all_nodes) {
                if (n.type === type) { n.color = new_color; }
            }
            draw();
            buildFilterCheckboxes();
            // Persist all node colors as an object
            const color_map: Record<string, string> = {};
            for (const t of present_types) {
                const node = m_all_nodes.find(n => n.type === t);
                if (node) { color_map[t] = node.color; }
            }
            m_vscode.postMessage({ type: 'updateSetting', key: 'graphNodeColors', value: color_map });
        });
    }

    // Reset buttons — restore any widget to its default value from provider_defaults
    // Handles: number inputs (data-defkey), selects, checkboxes, and color pickers (data-resetcolor)
    settings_panel.querySelectorAll<HTMLButtonElement>('.settings-reset-btn[data-defkey]').forEach(btn => {
        btn.addEventListener('click', () => {
            const def_key = btn.dataset.defkey!;
            const def_val = m_provider_defaults[def_key];
            if (def_val === undefined) { return; }
            const row = btn.closest('.settings-row, .settings-row-inline');
            if (!row) { return; }

            // Number input
            const num_input = row.querySelector<HTMLInputElement>('input[type="number"]');
            if (num_input) {
                const sim_key = num_input.dataset.simkey as keyof SimVars;
                const clamped = clampSimVar(sim_key, def_val);
                m_sim_vars[sim_key] = sim_key === 'stepsPerFrame' ? Math.round(clamped) : clamped;
                num_input.value = String(m_sim_vars[sim_key]);
                const setting_key = input_setting_keys[num_input.id];
                if (setting_key) { m_vscode.postMessage({ type: 'updateSetting', key: setting_key, value: m_sim_vars[sim_key] }); }
                startSimulation();
                return;
            }

            // Select
            const select = row.querySelector<HTMLSelectElement>('select');
            if (select) {
                select.value = String(def_val);
                select.dispatchEvent(new Event('change'));
                return;
            }

            // Checkbox
            const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
            if (checkbox) {
                checkbox.checked = !!def_val;
                checkbox.dispatchEvent(new Event('change'));
                return;
            }

            // simEnabled toggle (start/stop button)
            if (def_key === 'simEnabled') {
                m_sim_enabled = !!def_val;
                if (m_sim_enabled) { startSimulation(); } else { stopSimulation(); }
                updateStartStopBtn();
                m_vscode.postMessage({ type: 'updateSetting', key: 'graphSimEnabled', value: m_sim_enabled });
                return;
            }
        });
    });

    // Color picker reset buttons
    settings_panel.querySelectorAll<HTMLButtonElement>('.settings-reset-btn[data-resetcolor]').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.resetcolor!;
            const def_color = m_provider_defaults.nodeColors?.[type];
            if (!def_color) { return; }
            const picker = settings_panel!.querySelector(`#s-color-${type}`) as HTMLInputElement | null;
            if (!picker) { return; }
            picker.value = def_color;
            for (const n of m_all_nodes) {
                if (n.type === type) { n.color = def_color; }
            }
            draw();
            buildFilterCheckboxes();
            // Persist all node colors
            const color_map: Record<string, string> = {};
            const present = new Set(m_all_nodes.map(n => n.type));
            for (const t of present) {
                const node = m_all_nodes.find(n => n.type === t);
                if (node) { color_map[t] = node.color; }
            }
            m_vscode.postMessage({ type: 'updateSetting', key: 'graphNodeColors', value: color_map });
        });
    });

    // Start/Stop simulation
    const start_stop_btn = settings_panel.querySelector('#s-startstop') as HTMLButtonElement;
    start_stop_btn.addEventListener('click', () => {
        startStopSimulation();
    });

    // Restart simulation (reset positions)
    settings_panel.querySelector('#s-restart')!.addEventListener('click', () => {
        m_sim_enabled = true;
        resetLayoutPositions();
        updateStartStopBtn();
        m_vscode.postMessage({ type: 'updateSetting', key: 'graphSimEnabled', value: m_sim_enabled });
    });
}

// ------------------------------------------------------------
// Screenshot
// ------------------------------------------------------------
function takeScreenshot(): void {
    if (!m_canvas) { return; }
    const data_uri = m_canvas.toDataURL('image/png');
    m_vscode.postMessage({ type: 'saveScreenshot', dataUri: data_uri });
}

// ------------------------------------------------------------
// Apply settings received from the provider (workspace settings)
// ------------------------------------------------------------
function applySettingsFromProvider(aS: any): void {
    if (aS.edgeDirection !== undefined) { m_edge_direction = aS.edgeDirection as EdgeDirection || EdgeDirection.USED_BY; }
    if (aS.edgeStyle !== undefined) { m_edge_style = aS.edgeStyle as EdgeStyle || EdgeStyle.TAPERED; }
    if (aS.taperedWidth !== undefined) { m_sim_vars.taperedWidth = aS.taperedWidth; }
    if (aS.simRepulsion !== undefined) { m_sim_vars.repulsion = aS.simRepulsion; }
    if (aS.simAttraction !== undefined) { m_sim_vars.attraction = aS.simAttraction; }
    if (aS.simGravity !== undefined) { m_sim_vars.gravity = aS.simGravity; }
    if (aS.simLinkLength !== undefined) { m_sim_vars.linkLength = aS.simLinkLength; }
    if (aS.simMinDistance !== undefined) { m_sim_vars.minDistance = aS.simMinDistance; }
    if (aS.simStepsPerFrame !== undefined) { m_sim_vars.stepsPerFrame = aS.simStepsPerFrame; }
    if (aS.simThreshold !== undefined) { m_sim_vars.threshold = aS.simThreshold; }
    if (aS.simDamping !== undefined) { m_sim_vars.damping = aS.simDamping; }
    if (aS.minimap !== undefined) { m_minimap_enabled = aS.minimap; }
    if (aS.autoPauseDrag !== undefined) { m_auto_pause_during_drag = aS.autoPauseDrag; }
    if (aS.simEnabled !== undefined) { m_sim_enabled = aS.simEnabled; }
    if (aS.settingsCollapse !== undefined) { m_settings_collapse_state = aS.settingsCollapse; }
    if (aS.settingsVisible !== undefined) { m_settings_panel_visible = aS.settingsVisible; }
}

// ------------------------------------------------------------
// Message listener
// ------------------------------------------------------------
window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data;
    switch (msg.type) {
        case 'update': {
            if (msg.defaults) { m_provider_defaults = msg.defaults; }
            if (msg.settings) { applySettingsFromProvider(msg.settings); }
            createGraph(msg.nodes as GraphNode[], msg.edges as GraphEdge[]);
            break;
        }
        case 'showSettings':
            toggleSettings();
            break;
        case 'screenshot':
            takeScreenshot();
            break;
        case 'toggleLayout':
            // Reset velocities and restart
            for (const ln of m_layout_nodes) { ln.vx = 0; ln.vy = 0; }
            startSimulation();
            break;
        case 'focusNode':
            focusOnNode(msg.targetId as string);
            break;
        case 'exportCsv': {
            const node_map = new Map(m_all_nodes.map(n => [n.id, n]));
            const visible = new Set(m_all_nodes.filter(n => !isNodeFiltered(n)).map(n => n.id));
            const rows: { node_a: string; type_a: string; link_type: string; node_b: string; type_b: string }[] = [];
            for (const e of m_all_edges) {
                if (!visible.has(e.from) || !visible.has(e.to)) { continue; }
                const na = node_map.get(e.from);
                const nb = node_map.get(e.to);
                if (!na || !nb) { continue; }
                const src = m_edge_direction === EdgeDirection.IS_USING ? na : nb;
                const dst = m_edge_direction === EdgeDirection.IS_USING ? nb : na;
                rows.push({
                    node_a: src.label,
                    type_a: src.type,
                    link_type: m_edge_direction === EdgeDirection.IS_USING ? 'uses' : 'used_by',
                    node_b: dst.label,
                    type_b: dst.type,
                });
            }
            m_vscode.postMessage({ type: 'csvData', rows });
            break;
        }
    }
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function getCssVar(aName: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(aName).trim();
}

/** Returns true when the current VS Code theme is light */
function isLightTheme(): boolean {
    const bg = getCssVar('--vscode-editor-background');
    if (!bg) { return false; }
    // Parse the hex color and compute luminance
    const hex = bg.startsWith('#') ? bg : '#1e1e1e';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

/** Foreground color that contrasts with the editor background */
function themeFg(): string {
    return getCssVar('--vscode-editor-foreground') || (isLightTheme() ? '#000000' : '#ffffff');
}

/** Edge color with given alpha — uses foreground color so it's visible on any theme */
function themeEdgeColor(aAlpha: number): string {
    const light = isLightTheme();
    return light ? `rgba(0, 0, 0, ${aAlpha})` : `rgba(255, 255, 255, ${aAlpha})`;
}

function darken(aHex: string): string {
    return adjustBrightness(aHex, -0.3);
}

function adjustBrightness(aHex: string, aFactor: number): string {
    const r = parseInt(aHex.slice(1, 3), 16);
    const g = parseInt(aHex.slice(3, 5), 16);
    const b = parseInt(aHex.slice(5, 7), 16);
    const adj = (c: number) => Math.max(0, Math.min(255, Math.round(c + c * aFactor)));
    return `#${adj(r).toString(16).padStart(2, '0')}${adj(g).toString(16).padStart(2, '0')}${adj(b).toString(16).padStart(2, '0')}`;
}

/** Returns '#000000' or '#ffffff' depending on which has better contrast */
function contrastTextColor(aHex: string): string {
    const r = parseInt(aHex.slice(1, 3), 16);
    const g = parseInt(aHex.slice(3, 5), 16);
    const b = parseInt(aHex.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
m_vscode.postMessage({ type: 'ready' });
