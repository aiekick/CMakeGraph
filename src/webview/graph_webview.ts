// ------------------------------------------------------------
// Graph Webview — Orchestrator
//
// This is the main entry point for the webview. It manages:
// - Global state (nodes, edges, filters, selection, focus)
// - UI components (toolbar, search, breadcrumb, settings, footer)
// - Simulation loop (delegates to ISimulation)
// - Rendering (delegates to IGraphRenderer)
// - Message passing with the VS Code extension
// ------------------------------------------------------------

import {
    EdgeDirection, EdgeStyle,
    NODE_H, TARGET_TYPES, SIM_CLAMP,
    type GraphNode, type GraphEdge, type LayoutNode, type SimVars,
    type GraphState, type RendererCallbacks, type IGraphRenderer, type ISimulation,
    type PersistedState, type CameraState2D, type CameraState3D,
} from './types';
import { getCssVar, isLightTheme, escapeHtml, measureNodeWidth, clampSimVar } from './utils';
import { Graph2DRenderer } from './graph_renderer_2d';
import { Graph3DRenderer } from './graph_renderer_3d';
import { Simulation2D } from './simulation_2d';
import { Simulation3D } from './simulation_3d';

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
// State
// ------------------------------------------------------------
let m_all_nodes: GraphNode[] = [];
let m_all_edges: GraphEdge[] = [];
let m_layout_nodes: LayoutNode[] = [];
let m_active_filters = new Set<string>();
let m_selected_node_id: string | null = null;
let m_edge_style: EdgeStyle = EdgeStyle.TAPERED;
let m_edge_direction: EdgeDirection = EdgeDirection.USED_BY;
let m_sim_enabled = true;
let m_auto_pause_during_drag = false;
let m_search_filter = '';
let m_search_mode: 'name' | 'path' = 'name';
let m_search_filter_mode: 'dim' | 'hide' = 'hide';
let m_minimap_enabled = true;
let m_settings_collapse_state: Record<string, boolean> = { edges: false, colors: true, simulation: true, display: false, controls: false };
let m_settings_panel_visible = false;
let m_total_sim_energy = 0;
let m_frame_delta_ms = 0;
let m_frame_last_time = 0;
let m_footer_loaded = false;
let m_provider_defaults: Record<string, any> = {};
let m_3d_mode = false;

// Focus state
let m_focused_node_id: string | null = null;
let m_focus_history: { nodeId: string; label: string }[] = [];
let m_focus_visible_ids: Set<string> | null = null;
let m_focus_depth = 0;
let m_focus_max_depth = 0;
let m_focus_node_depths: Map<string, number> | null = null;

// Simulation parameters
const m_sim_vars: SimVars = {
    repulsion: 10000, attraction: 0.1, gravity: 0.001, linkLength: 0.1,
    minDistance: 50, stepsPerFrame: 5, threshold: 2, damping: 0.85, taperedWidth: 1.0,
};

let m_sim_running = false;
let m_sim_anim_frame: number | null = null;

// Canvas
let m_canvas: HTMLCanvasElement | null = null;
let m_first_layout = true;

// Renderer & Simulation (polymorphic)
let m_renderer: IGraphRenderer = new Graph2DRenderer();
let m_simulation: ISimulation = new Simulation2D();

// Settings panel
let settings_panel: HTMLDivElement | null = null;

// ------------------------------------------------------------
// Search / Filter helpers
// ------------------------------------------------------------
function nodeMatchesSearch(aNode: GraphNode): boolean {
    if (!m_search_filter) { return true; }
    const query = m_search_filter.toLowerCase();
    const target = m_search_mode === 'name' ? aNode.label : aNode.sourcePath;
    try {
        if (m_search_filter.includes('*') || m_search_filter.includes('(') || m_search_filter.includes('[')) {
            return new RegExp(m_search_filter, 'i').test(target);
        }
    } catch { /* fallback */ }
    return target.toLowerCase().includes(query);
}

function isNodeFiltered(aNode: GraphNode): boolean {
    if (m_active_filters.has(aNode.type)) { return true; }
    if (m_search_filter_mode === 'hide') {
        if (m_search_filter && !nodeMatchesSearch(aNode)) { return true; }
        if (m_focus_visible_ids && !m_focus_visible_ids.has(aNode.id)) { return true; }
    }
    return false;
}

function isNodeDimmed(aNode: GraphNode): boolean {
    if (m_search_filter.length > 0 && !nodeMatchesSearch(aNode)) { return true; }
    if (m_focus_visible_ids && !m_focus_visible_ids.has(aNode.id)) { return true; }
    return false;
}

// ------------------------------------------------------------
// Graph state (passed to renderer)
// ------------------------------------------------------------
function buildGraphState(): GraphState {
    return {
        selectedNodeId: m_selected_node_id,
        focusedNodeId: m_focused_node_id,
        edgeStyle: m_edge_style,
        edgeDirection: m_edge_direction,
        simVars: m_sim_vars,
        minimapEnabled: m_minimap_enabled && !m_3d_mode,
        searchFilter: m_search_filter,
        searchMode: m_search_mode,
        searchFilterMode: m_search_filter_mode,
        isNodeFiltered,
        isNodeDimmed,
        focusVisibleIds: m_focus_visible_ids,
    };
}

// ------------------------------------------------------------
// Renderer callbacks
// ------------------------------------------------------------
const m_renderer_callbacks: RendererCallbacks = {
    onNodeClick(aNode: LayoutNode): void {
        m_selected_node_id = aNode.node.id;
        updateFooter();
        if (aNode.node.type !== 'SYSTEM_LIBRARY') {
            m_vscode.postMessage({ type: 'nodeClick', targetId: aNode.node.id });
        }
    },
    onNodeDragStart(aNode: LayoutNode): void {
        if (m_auto_pause_during_drag && m_sim_running) {
            stopSimulation();
        }
    },
    onNodeDragEnd(): void {
        if (m_sim_enabled) { startSimulation(); }
    },
    onBackgroundClick(): void {
        m_selected_node_id = null;
        updateFooter();
        draw();
    },
    onDoubleClickNode(aNodeId: string, aCtrlKey: boolean): void {
        if (aNodeId === m_focused_node_id) {
            shiftOriginToNode(aNodeId);
            restartSimIfEnabled();
            draw();
            return;
        }
        if (aCtrlKey) {
            exitFocusView();
            focusOnNode(aNodeId);
        } else {
            focusOnNode(aNodeId);
        }
    },
    onDoubleClickBackground(): void {
        m_renderer.centerOnNodes(m_layout_nodes, isNodeFiltered);
        draw();
    },
    onRequestDraw(): void {
        draw();
    },
    onCameraChanged(): void {
        saveState();
    },
    onStartStopSimulation(): void {
        startStopSimulation();
    },
};

// ------------------------------------------------------------
// State persistence
// ------------------------------------------------------------
function saveState(): void {
    const persisted: PersistedState = { mode3d: m_3d_mode };
    const cam = m_renderer.saveCamera();
    if (cam.kind === '2d') {
        const c = cam as CameraState2D;
        persisted.camX = c.camX;
        persisted.camY = c.camY;
        persisted.zoom = c.zoom;
    } else {
        const c = cam as CameraState3D;
        persisted.camYaw = c.camYaw;
        persisted.camPitch = c.camPitch;
        persisted.camDistance = c.camDistance;
        persisted.camTargetX = c.targetX;
        persisted.camTargetY = c.targetY;
        persisted.camTargetZ = c.targetZ;
    }
    m_vscode.setState(persisted);
}

function restoreState(): boolean {
    const s = m_vscode.getState() as PersistedState | undefined;
    if (!s || (s.camX === undefined && s.camYaw === undefined)) { return false; }
    if (s.mode3d !== undefined) { m_3d_mode = s.mode3d; }
    if (m_3d_mode) {
        if (s.camYaw !== undefined) {
            return m_renderer.restoreCamera({
                kind: '3d', camYaw: s.camYaw, camPitch: s.camPitch ?? 0.5, camDistance: s.camDistance ?? 500,
                targetX: s.camTargetX, targetY: s.camTargetY, targetZ: s.camTargetZ,
            });
        }
    } else {
        if (s.camX !== undefined) {
            return m_renderer.restoreCamera({ kind: '2d', camX: s.camX, camY: s.camY!, zoom: s.zoom! });
        }
    }
    return false;
}

// ------------------------------------------------------------
// Canvas setup
// ------------------------------------------------------------
function setupCanvas(): void {
    const container = document.getElementById('graph-container')!;
    container.style.display = 'block';
    document.getElementById('empty-message')!.style.display = 'none';

    if (!m_canvas) {
        m_canvas = createCanvasElement();
        container.innerHTML = '';
        container.appendChild(m_canvas);
    }

    m_renderer.init(m_canvas);
    m_renderer.attachEvents(m_canvas, m_renderer_callbacks);
    resizeCanvas();
}

function createCanvasElement(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.tabIndex = 0;
    c.style.display = 'block';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.outline = 'none';
    return c;
}

function resizeCanvas(): void {
    if (!m_canvas) { return; }
    const container = m_canvas.parentElement!;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const pw = rect.width * dpr, ph = rect.height * dpr;
    const cssW = `${rect.width}px`, cssH = `${rect.height}px`;

    // Resize main canvas
    m_canvas.width = pw;
    m_canvas.height = ph;
    m_canvas.style.width = cssW;
    m_canvas.style.height = cssH;

    // For 2D mode: apply DPR transform on 2D context
    const ctx2d = m_canvas.getContext('2d');
    if (ctx2d) { ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0); }

    // Resize overlay canvas if it exists (3D mode)
    const overlay = m_canvas.parentElement!.querySelector('canvas[data-overlay]') as HTMLCanvasElement | null;
    if (overlay) {
        overlay.width = pw;
        overlay.height = ph;
        overlay.style.width = cssW;
        overlay.style.height = cssH;
        const octx = overlay.getContext('2d');
        if (octx) { octx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    }

    draw();
}

// ------------------------------------------------------------
// Drawing (delegates to renderer)
// ------------------------------------------------------------
function draw(): void {
    m_renderer.draw(m_layout_nodes, m_all_edges, buildGraphState());
}

// ------------------------------------------------------------
// Simulation loop
// ------------------------------------------------------------
function restartSimIfEnabled(): void {
    if (m_sim_enabled) { stopSimulation(); startSimulation(); }
}

function startSimulation(): void {
    if (m_sim_running || !m_sim_enabled) { return; }
    m_sim_running = true;
    m_sim_anim_frame = requestAnimationFrame(simulationStep);
}

function stopSimulation(): void {
    m_sim_running = false;
    if (m_sim_anim_frame !== null) { cancelAnimationFrame(m_sim_anim_frame); m_sim_anim_frame = null; }
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

function simulationStep(): void {
    if (!m_sim_running) { return; }
    const now = performance.now();
    if (m_frame_last_time > 0) { m_frame_delta_ms = now - m_frame_last_time; }
    m_frame_last_time = now;

    const dragNode = m_renderer.getDragNode();
    for (let step = 0; step < m_sim_vars.stepsPerFrame; step++) {
        m_total_sim_energy = m_simulation.step(
            m_layout_nodes, m_all_edges, m_sim_vars,
            isNodeFiltered, dragNode,
            (ln) => ln.pinned || (m_renderer.isDraggingNode() && m_renderer.getDragNode() === ln),
        );
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
// Graph creation
// ------------------------------------------------------------
function createGraph(aNodes: GraphNode[], aEdges: GraphEdge[]): void {
    stopSimulation();
    const filtered = aNodes.filter(n => n.type !== 'UTILITY');
    const seen = new Set<string>();
    const unique: GraphNode[] = [];
    for (const n of filtered) { if (!seen.has(n.id)) { seen.add(n.id); unique.push(n); } }
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
        const prevCamera = m_first_layout ? null : m_renderer.saveCamera();
        initRendererForCurrentMode();
        setupCanvas();
        if (prevCamera && m_renderer.restoreCamera(prevCamera)) {
            // Preserved camera from before reload
        } else if (!restoreState()) {
            m_renderer.centerOnNodes(m_layout_nodes, isNodeFiltered);
        }
        m_first_layout = false;
        draw();
        startSimulation();
        if (m_settings_panel_visible && !settings_panel) { toggleSettings(false); }
    }, 50);
}

function initRendererForCurrentMode(): void {
    m_renderer.dispose();
    if (m_3d_mode) {
        m_renderer = new Graph3DRenderer();
        m_simulation = new Simulation3D();
    } else {
        m_renderer = new Graph2DRenderer();
        m_simulation = new Simulation2D();
    }
}

function arrangeNodesInCircle(aNodes: LayoutNode[], aRadius: number): void {
    for (let i = 0; i < aNodes.length; i++) {
        const angle = (2 * Math.PI * i) / aNodes.length;
        aNodes[i].x = Math.cos(angle) * aRadius;
        aNodes[i].y = Math.sin(angle) * aRadius;
        aNodes[i].z = 0;
        aNodes[i].vx = 0; aNodes[i].vy = 0; aNodes[i].vz = 0;
    }
}

function arrangeNodesInSphere(aNodes: LayoutNode[], aRadius: number): void {
    const golden = (1 + Math.sqrt(5)) / 2;
    const n = aNodes.length;
    for (let i = 0; i < n; i++) {
        const theta = 2 * Math.PI * i / golden;
        const phi = Math.acos(1 - 2 * (i + 0.5) / n);
        aNodes[i].x = Math.cos(theta) * Math.sin(phi) * aRadius;
        aNodes[i].y = Math.sin(theta) * Math.sin(phi) * aRadius;
        aNodes[i].z = Math.cos(phi) * aRadius;
        aNodes[i].vx = 0; aNodes[i].vy = 0; aNodes[i].vz = 0;
    }
}

function initLayoutNodes(aNodes: GraphNode[]): void {
    const existing = new Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number }>();
    for (const ln of m_layout_nodes) {
        existing.set(ln.node.id, { x: ln.x, y: ln.y, z: ln.z, vx: ln.vx, vy: ln.vy, vz: ln.vz });
    }
    const widths = aNodes.map(n => measureNodeWidth(n.label));
    m_layout_nodes = [];
    const new_nodes: LayoutNode[] = [];
    for (let i = 0; i < aNodes.length; i++) {
        const n = aNodes[i];
        const w = widths[i];
        const ex = existing.get(n.id);
        if (ex) {
            m_layout_nodes.push({ node: n, x: ex.x, y: ex.y, z: ex.z, w, vx: ex.vx, vy: ex.vy, vz: ex.vz, mass: 1, pinned: false });
        } else {
            const ln: LayoutNode = { node: n, x: 0, y: 0, z: 0, w, vx: 0, vy: 0, vz: 0, mass: 1, pinned: false };
            m_layout_nodes.push(ln);
            new_nodes.push(ln);
        }
    }
    if (m_3d_mode) {
        arrangeNodesInSphere(new_nodes, Math.max(100, aNodes.length * 10));
    } else {
        arrangeNodesInCircle(new_nodes, Math.max(100, aNodes.length * 10));
    }
}

function resetLayoutPositions(): void {
    stopSimulation();
    if (m_3d_mode) {
        arrangeNodesInSphere(m_layout_nodes, Math.max(150, m_layout_nodes.length * 20));
    } else {
        arrangeNodesInCircle(m_layout_nodes, Math.max(150, m_layout_nodes.length * 20));
    }
    draw();
    startSimulation();
}

// ------------------------------------------------------------
// 2D/3D toggle
// ------------------------------------------------------------
function toggle3DMode(): void {
    m_3d_mode = !m_3d_mode;
    m_renderer.detachEvents();
    m_renderer.dispose();
    if (m_3d_mode) {
        m_renderer = new Graph3DRenderer();
        m_simulation = new Simulation3D();
        arrangeNodesInSphere(m_layout_nodes, Math.max(150, m_layout_nodes.length * 20));
    } else {
        m_renderer = new Graph2DRenderer();
        m_simulation = new Simulation2D();
        for (const ln of m_layout_nodes) { ln.z = 0; ln.vz = 0; }
    }
    // Recreate canvas — a canvas with a WebGL context can't switch to 2D and vice-versa
    if (m_canvas) {
        const container = m_canvas.parentElement!;
        container.innerHTML = '';
        m_canvas = createCanvasElement();
        container.appendChild(m_canvas);
        m_renderer.init(m_canvas);
        m_renderer.attachEvents(m_canvas, m_renderer_callbacks);
        resizeCanvas();
        m_renderer.centerOnNodes(m_layout_nodes, isNodeFiltered);
    }
    m_vscode.postMessage({ type: 'updateSetting', key: 'graph3DMode', value: m_3d_mode });
    const btn = document.getElementById('mode-3d-btn');
    if (btn) { btn.textContent = m_3d_mode ? '3D' : '2D'; }
    restartSimIfEnabled();
    saveState();
    draw();
}

// ------------------------------------------------------------
// Focus view
// ------------------------------------------------------------
function buildConnectedSubgraph(aRootId: string): Map<string, number> {
    const depths = new Map<string, number>();
    const queue: [string, number][] = [[aRootId, 0]];
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
        if (neighbors) { for (const nb of neighbors) { if (!depths.has(nb)) { queue.push([nb, depth + 1]); } } }
    }
    return depths;
}

function rebuildFocusVisibleIds(): void {
    if (!m_focus_node_depths) { m_focus_visible_ids = null; return; }
    const ids = new Set<string>();
    for (const [id, d] of m_focus_node_depths) { if (d <= m_focus_depth) { ids.add(id); } }
    m_focus_visible_ids = ids;
}

function rebuildFocusSubgraph(aNodeId: string): void {
    m_focus_node_depths = buildConnectedSubgraph(aNodeId);
    m_focus_max_depth = 0;
    for (const d of m_focus_node_depths.values()) { if (d > m_focus_max_depth) { m_focus_max_depth = d; } }
    m_focus_depth = m_focus_max_depth;
    rebuildFocusVisibleIds();
    buildFilterCheckboxes();
    updateBreadcrumb();
}

function refreshFocusSubgraph(): void {
    if (m_focused_node_id) { rebuildFocusSubgraph(m_focused_node_id); }
}

function shiftOriginToNode(aNodeId: string): void {
    const focus_ln = m_layout_nodes.find(ln => ln.node.id === aNodeId);
    if (!focus_ln) { return; }
    const dx = focus_ln.x, dy = focus_ln.y, dz = focus_ln.z;
    for (const ln of m_layout_nodes) { ln.x -= dx; ln.y -= dy; ln.z -= dz; }
}

function focusOnNode(aNodeId: string): void {
    const node = m_all_nodes.find(n => n.id === aNodeId);
    if (!node) { return; }
    if (m_focus_history.length === 0 || m_focus_history[m_focus_history.length - 1].nodeId !== aNodeId) {
        m_focus_history.push({ nodeId: aNodeId, label: node.label });
    }
    m_focused_node_id = aNodeId;
    m_selected_node_id = aNodeId;
    rebuildFocusSubgraph(aNodeId);

    const root_ln = m_layout_nodes.find(ln => ln.node.id === aNodeId);
    if (root_ln) { root_ln.pinned = true; root_ln.x = 0; root_ln.y = 0; root_ln.z = 0; root_ln.vx = 0; root_ln.vy = 0; root_ln.vz = 0; }
    const visible_ids = m_focus_visible_ids ?? new Set<string>();
    const sub_nodes = m_layout_nodes.filter(ln => ln.node.id !== aNodeId && visible_ids.has(ln.node.id));
    if (m_3d_mode) {
        arrangeNodesInSphere(sub_nodes, Math.max(150, sub_nodes.length * 25));
    } else {
        arrangeNodesInCircle(sub_nodes, Math.max(150, sub_nodes.length * 25));
    }

    m_renderer.centerOnNodes(m_layout_nodes, isNodeFiltered);
    restartSimIfEnabled();
    updateFooter();
    draw();
}

function exitFocusView(): void {
    for (const ln of m_layout_nodes) { ln.pinned = false; }
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
    if (aIndex < 0) { exitFocusView(); return; }
    m_focus_history = m_focus_history.slice(0, aIndex + 1);
    const entry = m_focus_history[aIndex];
    m_focused_node_id = entry.nodeId;
    m_selected_node_id = entry.nodeId;
    rebuildFocusSubgraph(entry.nodeId);
    restartSimIfEnabled();
    updateFooter();
    draw();
}

// ------------------------------------------------------------
// Resize handling
// ------------------------------------------------------------
let resize_timer: ReturnType<typeof setTimeout> | null = null;
function onResize(): void {
    if (resize_timer) { clearTimeout(resize_timer); }
    resize_timer = setTimeout(() => { recalcContainerHeight(); resizeCanvas(); }, 50);
}
function recalcContainerHeight(): void {
    const container = document.getElementById('graph-container')!;
    const th = document.getElementById('toolbar')?.offsetHeight ?? 0;
    const fh = document.getElementById('footer')?.offsetHeight ?? 0;
    const bh = document.getElementById('breadcrumb-bar')?.offsetHeight ?? 0;
    container.style.height = `${Math.max(200, window.innerHeight - th - fh - bh)}px`;
}
window.addEventListener('resize', onResize);
const graph_container = document.getElementById('graph-container')!;
const resize_observer = new ResizeObserver(onResize);
resize_observer.observe(graph_container);

// ------------------------------------------------------------
// Search bar
// ------------------------------------------------------------
let search_bar_inited = false;
function initSearchBar(): void {
    if (search_bar_inited) { return; }
    search_bar_inited = true;
    const bar = document.getElementById('breadcrumb-bar')!;
    bar.innerHTML = buildHelpButtonHtml() + build3DModeButtonHtml() + buildSearchControlsHtml() +
        '<span class="breadcrumb-separator">\u2502</span>' + buildEdgeDirectionHtml();
    attachSearchEvents();
    attachEdgeDirectionEvents();
    attach3DModeEvents();
}

function build3DModeButtonHtml(): string {
    return `<button id="mode-3d-btn" title="Toggle 2D/3D mode">${m_3d_mode ? '3D' : '2D'}</button>`;
}

function attach3DModeEvents(): void {
    const btn = document.getElementById('mode-3d-btn');
    if (btn) { btn.addEventListener('click', toggle3DMode); }
}

function buildHelpButtonHtml(): string {
    const lines = [
        'Click \u2014 Select node',
        'Double-click node \u2014 Focus subgraph (drill down)',
        'Ctrl+Double-click \u2014 Focus subgraph (fresh root)',
        'Double-click background \u2014 Fit to view',
        'Scroll \u2014 Zoom',
        'Drag node \u2014 Move node',
        'Drag background \u2014 Pan (2D) / Rotate (3D)',
    ];
    return `<button id="help-btn" title="${lines.join('&#10;')}">?</button>`;
}

function buildSearchControlsHtml(): string {
    const fi = m_search_filter_mode === 'dim' ? '\u{1F441}' : '\u{1F6AB}';
    const ft = m_search_filter_mode === 'dim' ? 'Mode: Dim non-matching (click to switch to Hide)' : 'Mode: Hide non-matching (click to switch to Dim)';
    const ml = m_search_mode === 'name' ? 'N' : 'P';
    const mt = m_search_mode === 'name' ? 'Filtering by name (click to switch to path)' : 'Filtering by path (click to switch to name)';
    const ph = m_search_mode === 'name' ? 'Filter by name\u2026' : 'Filter by path\u2026';
    return `<div id="search-container"><button id="search-filter-mode" title="${ft}">${fi}</button><button id="search-mode" title="${mt}">${ml}</button><input id="search-input" type="text" placeholder="${ph}" spellcheck="false" value="${escapeHtml(m_search_filter)}"><button id="search-clear" title="Clear filter">\u2715</button></div>`;
}

function attachSearchEvents(): void {
    const input = document.getElementById('search-input') as HTMLInputElement;
    const mode_btn = document.getElementById('search-mode') as HTMLButtonElement;
    const fmode_btn = document.getElementById('search-filter-mode') as HTMLButtonElement;
    const clear_btn = document.getElementById('search-clear') as HTMLButtonElement;
    if (!input || !mode_btn || !clear_btn || !fmode_btn) { return; }
    mode_btn.addEventListener('click', () => {
        m_search_mode = m_search_mode === 'name' ? 'path' : 'name';
        input.placeholder = m_search_mode === 'name' ? 'Filter by name\u2026' : 'Filter by path\u2026';
        mode_btn.textContent = m_search_mode === 'name' ? 'N' : 'P';
        mode_btn.title = m_search_mode === 'name' ? 'Filtering by name (click to switch to path)' : 'Filtering by path (click to switch to name)';
        applySearchFilter();
    });
    fmode_btn.addEventListener('click', () => {
        m_search_filter_mode = m_search_filter_mode === 'dim' ? 'hide' : 'dim';
        fmode_btn.textContent = m_search_filter_mode === 'dim' ? '\u{1F441}' : '\u{1F6AB}';
        fmode_btn.title = m_search_filter_mode === 'dim' ? 'Mode: Dim non-matching (click to switch to Hide)' : 'Mode: Hide non-matching (click to switch to Dim)';
        applySearchFilter();
    });
    clear_btn.addEventListener('click', () => { m_search_filter = ''; input.value = ''; applySearchFilter(); });
    input.addEventListener('input', () => { m_search_filter = input.value; applySearchFilter(); });
}

function applySearchFilter(): void {
    if (m_search_filter_mode === 'hide') { restartSimIfEnabled(); }
    draw();
}

// ------------------------------------------------------------
// Type filters
// ------------------------------------------------------------
function buildFilterCheckboxes(): void {
    const container = document.getElementById('filters')!;
    container.innerHTML = '';
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
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !m_active_filters.has(type);
        cb.addEventListener('change', () => {
            if (cb.checked) { m_active_filters.delete(type); } else { m_active_filters.add(type); }
            restartSimIfEnabled();
            draw();
        });
        const span = document.createElement('span');
        const node_of_type = m_all_nodes.find(n => n.type === type);
        span.textContent = ` ${type} (${count})`;
        span.style.color = node_of_type?.color ?? (getCssVar('--vscode-descriptionForeground') || '#888');
        label.appendChild(cb);
        label.appendChild(span);
        container.appendChild(label);
    }
}

// ------------------------------------------------------------
// Edge direction
// ------------------------------------------------------------
function buildEdgeDirectionHtml(): string {
    return `<div id="edge-dir-control" style="display:inline-flex;align-items:center;gap:2px;"><select id="bc-edgeDirection" title="Edge direction"><option value="${EdgeDirection.USED_BY}"${m_edge_direction === EdgeDirection.USED_BY ? ' selected' : ''}>Used by</option><option value="${EdgeDirection.IS_USING}"${m_edge_direction === EdgeDirection.IS_USING ? ' selected' : ''}>Is using</option></select><button class="settings-reset-btn" id="bc-edgeDir-reset" title="Reset to default value">\u21B6</button></div>`;
}

function syncEdgeDirectionSelects(aValue: string, aSourceId: string): void {
    for (const id of ['bc-edgeDirection', 's-edgeDirection']) {
        if (id === aSourceId) { continue; }
        const sel = document.getElementById(id) as HTMLSelectElement | null;
        if (sel) { sel.value = aValue; }
    }
}

function applyEdgeDirection(aDir: EdgeDirection, aSourceId: string): void {
    m_edge_direction = aDir;
    m_vscode.postMessage({ type: 'updateSetting', key: 'graphEdgeDirection', value: m_edge_direction });
    refreshFocusSubgraph();
    syncEdgeDirectionSelects(aDir as string, aSourceId);
    restartSimIfEnabled();
    draw();
}

function attachEdgeDirectionEvents(): void {
    const sel = document.getElementById('bc-edgeDirection') as HTMLSelectElement | null;
    const reset = document.getElementById('bc-edgeDir-reset') as HTMLButtonElement | null;
    if (!sel) { return; }
    sel.addEventListener('change', () => applyEdgeDirection(sel.value as EdgeDirection, 'bc-edgeDirection'));
    if (reset) {
        reset.addEventListener('click', () => {
            const def = m_provider_defaults['edgeDirection'];
            if (def === undefined) { return; }
            sel.value = String(def);
            sel.dispatchEvent(new Event('change'));
        });
    }
}

// ------------------------------------------------------------
// Breadcrumb
// ------------------------------------------------------------
function updateBreadcrumb(): void {
    const bar = document.getElementById('breadcrumb-bar')!;
    let html = buildHelpButtonHtml() + build3DModeButtonHtml() + buildSearchControlsHtml();
    if (m_focused_node_id && m_focus_history.length > 0) {
        html += '<span class="breadcrumb-separator">\u2502</span>' + buildDepthControlHtml();
    }
    html += '<span class="breadcrumb-separator">\u2502</span>' + buildEdgeDirectionHtml();
    if (m_focused_node_id && m_focus_history.length > 0) {
        html += '<span class="breadcrumb-separator">\u2502</span>';
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
    attachSearchEvents();
    attachEdgeDirectionEvents();
    attach3DModeEvents();
    if (m_focused_node_id) { attachDepthEvents(); }
    bar.querySelectorAll('.breadcrumb-item').forEach(el => {
        el.addEventListener('click', () => navigateBreadcrumb(parseInt((el as HTMLElement).dataset.bcIndex!, 10)));
    });
    recalcContainerHeight();
}

function buildDepthControlHtml(): string {
    const val = m_focus_depth >= m_focus_max_depth ? m_focus_max_depth : m_focus_depth;
    return `<div id="depth-control"><button id="depth-dec" title="Decrease depth">\u25C0</button><input id="depth-input" type="number" min="1" max="${m_focus_max_depth}" value="${val}" title="Subgraph depth"><button id="depth-inc" title="Increase depth">\u25B6</button><button id="depth-max" title="Show all depths">Max</button></div>`;
}

function attachDepthEvents(): void {
    const input = document.getElementById('depth-input') as HTMLInputElement | null;
    const dec = document.getElementById('depth-dec') as HTMLButtonElement | null;
    const inc = document.getElementById('depth-inc') as HTMLButtonElement | null;
    const max = document.getElementById('depth-max') as HTMLButtonElement | null;
    if (!input || !dec || !inc || !max) { return; }
    const apply = (d: number) => {
        m_focus_depth = Math.max(1, Math.min(m_focus_max_depth, d));
        input.value = String(m_focus_depth);
        rebuildFocusVisibleIds();
        buildFilterCheckboxes();
        restartSimIfEnabled();
        draw();
    };
    dec.addEventListener('click', () => apply(m_focus_depth - 1));
    inc.addEventListener('click', () => apply(m_focus_depth + 1));
    max.addEventListener('click', () => apply(m_focus_max_depth));
    input.addEventListener('change', () => { const v = parseInt(input.value, 10); if (!isNaN(v)) { apply(v); } });
}

// ------------------------------------------------------------
// Footer
// ------------------------------------------------------------
let m_footer_node_id: string | null = null;

function updatePerFrameDatas(): void {
    const e = document.getElementById('f-energy');
    if (e) { e.textContent = m_total_sim_energy.toFixed(2); }
    const d = document.getElementById('f-delta');
    if (d) { d.textContent = m_frame_delta_ms > 0 ? m_frame_delta_ms.toFixed(1) : 'paused'; }
}

function updateFooter(): void {
    const footer = document.getElementById('footer')!;
    if (m_footer_loaded && (m_footer_node_id === m_selected_node_id)) { updatePerFrameDatas(); return; }
    m_footer_node_id = m_selected_node_id;
    let html = `<span><span class="info-label">Delta:</span> <span id="f-delta" class="info-value">${m_frame_delta_ms > 0 ? m_frame_delta_ms.toFixed(1) : '\u2014'}</span> <span class="info-label">ms</span></span>` +
        `<span><span class="info-label">Energy:</span> <span id="f-energy" class="info-value">${m_total_sim_energy.toFixed(2)}</span></span>`;
    if (!m_selected_node_id) { footer.innerHTML = html; return; }
    const ln = m_layout_nodes.find(l => l.node.id === m_selected_node_id);
    if (!ln) { footer.innerHTML = html; return; }
    const n = ln.node;
    html += `<span><span class="info-type-swatch" style="background:${n.color}"></span><span class="info-value">${escapeHtml(n.label)}</span></span>` +
        `<span><span class="info-label">Type:</span> <span class="info-value">${escapeHtml(n.type)}</span></span>` +
        `<span><span class="info-label">Path:</span> <span class="info-value" title="${escapeHtml(n.sourcePath)}">${escapeHtml(n.sourcePath)}</span></span>` +
        `<span class="footer-right"><label class="settings-checkbox"><input type="checkbox" id="f-pin"${ln.pinned ? ' checked' : ''}> Frozen</label></span>`;
    footer.innerHTML = html;
    footer.querySelector('#f-pin')!.addEventListener('change', () => {
        const cb = footer.querySelector('#f-pin') as HTMLInputElement;
        ln.pinned = cb.checked;
        if (ln.pinned) { ln.vx = 0; ln.vy = 0; ln.vz = 0; }
    });
    m_footer_loaded = true;
}

// ------------------------------------------------------------
// Settings panel
// ------------------------------------------------------------
function toggleSettings(aPersist = true): void {
    if (settings_panel) {
        settings_panel.remove(); settings_panel = null;
        if (aPersist) { m_vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsVisible', value: false }); }
        return;
    }
    settings_panel = document.createElement('div');
    settings_panel.id = 'settings-panel';
    settings_panel.innerHTML = buildSettingsHtml();
    document.getElementById('graph-container')!.appendChild(settings_panel);
    attachSettingsEvents();
    if (aPersist) { m_vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsVisible', value: true }); }
}

function resetBtn(aKey: string): string {
    return `<button class="settings-reset-btn" data-defkey="${aKey}" title="Reset to default value">\u21B6</button>`;
}

function inputRow(aId: string, aLabel: string, aSimKey: keyof SimVars, aValue: number, aDefKey: string): string {
    const [lo, hi] = SIM_CLAMP[aSimKey];
    return `<div class="settings-row-inline"><label>${aLabel}</label><div class="settings-input-row"><input type="number" id="s-${aId}" min="${lo}" max="${hi}" value="${aValue}" data-simkey="${aSimKey}">${resetBtn(aDefKey)}</div></div>`;
}

function sectionHtml(aId: string, aTitle: string, aContent: string): string {
    const collapsed = m_settings_collapse_state[aId] ?? false;
    return `<div class="settings-section" data-section="${aId}"><div class="settings-title" data-collapse="${aId}">${collapsed ? '\u25B6' : '\u25BC'} ${aTitle}</div><div class="settings-content" id="sc-${aId}" style="display:${collapsed ? 'none' : 'flex'}">${aContent}</div></div>`;
}

function buildNodeColorPickersHtml(): string {
    const types = new Map<string, string>();
    for (const n of m_all_nodes) { if (!types.has(n.type)) { types.set(n.type, n.color); } }
    if (types.size === 0) { return ''; }
    let inner = '';
    for (const [type, color] of types) {
        inner += `<div class="settings-row-inline"><label class="settings-inline">${type}<input type="color" id="s-color-${type}" value="${color}"></label><button class="settings-reset-btn" data-resetcolor="${type}" title="Reset to default color">\u21B6</button></div>`;
    }
    return sectionHtml('colors', 'Node Colors', inner);
}

function updateStartStopBtn(): void {
    const btn = settings_panel?.querySelector('#s-startstop') as HTMLButtonElement | null;
    if (btn) { btn.textContent = m_sim_enabled ? '\u23F8 Stop' : '\u25B6 Start'; }
}

function buildSettingsHtml(): string {
    const edges = `<div class="settings-row-inline"><label>Style</label><select id="s-edgeStyle"><option value="${EdgeStyle.TAPERED}"${m_edge_style === EdgeStyle.TAPERED ? ' selected' : ''}>Tapered</option><option value="${EdgeStyle.CHEVRONS}"${m_edge_style === EdgeStyle.CHEVRONS ? ' selected' : ''}>Chevrons</option><option value="${EdgeStyle.LINE}"${m_edge_style === EdgeStyle.LINE ? ' selected' : ''}>Line</option></select>${resetBtn('edgeStyle')}</div><div class="settings-row-inline"><label>Direction</label><select id="s-edgeDirection"><option value="${EdgeDirection.USED_BY}"${m_edge_direction === EdgeDirection.USED_BY ? ' selected' : ''}>Used by</option><option value="${EdgeDirection.IS_USING}"${m_edge_direction === EdgeDirection.IS_USING ? ' selected' : ''}>Is using</option></select>${resetBtn('edgeDirection')}</div>${inputRow('taperedWidth', 'Tapered Width', 'taperedWidth', m_sim_vars.taperedWidth, 'taperedWidth')}`;

    const sim = `${inputRow('repulsion', 'Repulsion', 'repulsion', m_sim_vars.repulsion, 'simRepulsion')}${inputRow('attraction', 'Attraction', 'attraction', m_sim_vars.attraction, 'simAttraction')}${inputRow('gravity', 'Gravity', 'gravity', m_sim_vars.gravity, 'simGravity')}${inputRow('linkLength', 'Link Length', 'linkLength', m_sim_vars.linkLength, 'simLinkLength')}${inputRow('minDist', 'Min Distance', 'minDistance', m_sim_vars.minDistance, 'simMinDistance')}${inputRow('steps', 'Steps/Frame', 'stepsPerFrame', m_sim_vars.stepsPerFrame, 'simStepsPerFrame')}${inputRow('threshold', 'Threshold', 'threshold', m_sim_vars.threshold, 'simThreshold')}${inputRow('damping', 'Damping', 'damping', m_sim_vars.damping, 'simDamping')}`;

    const display = `<div class="settings-row-inline"><label class="settings-checkbox"><input type="checkbox" id="s-3dmode"${m_3d_mode ? ' checked' : ''}> 3D Mode</label>${resetBtn('mode3d')}</div><div class="settings-row-inline"><label class="settings-checkbox"><input type="checkbox" id="s-minimap"${m_minimap_enabled ? ' checked' : ''}${m_3d_mode ? ' disabled' : ''}> Show minimap</label>${resetBtn('minimap')}</div>`;

    const controls = `<div class="settings-row-inline"><label class="settings-checkbox"><input type="checkbox" id="s-autoPause"${m_auto_pause_during_drag ? ' checked' : ''}> Pause during node dragging</label>${resetBtn('autoPauseDrag')}</div><div class="settings-row-inline"><label>Simulation</label><button id="s-startstop" class="settings-row-inline-button">${m_sim_enabled ? '\u23F8 Stop' : '\u25B6 Start'}</button>${resetBtn('simEnabled')}</div><button id="s-restart" class="full-width-btn">\u21BA Restart Simulation</button>`;

    return `<div class="settings-body">${sectionHtml('controls', 'Controls', controls)}${sectionHtml('display', 'Display', display)}${sectionHtml('edges', 'Edges', edges)}${sectionHtml('simulation', 'Force Simulation', sim)}${buildNodeColorPickersHtml()}</div>`;
}

function applyNodeColor(aType: string, aColor: string): void {
    for (const n of m_all_nodes) { if (n.type === aType) { n.color = aColor; } }
    draw();
    buildFilterCheckboxes();
    persistNodeColors();
}

function persistNodeColors(): void {
    const map: Record<string, string> = {};
    const types = new Set(m_all_nodes.map(n => n.type));
    for (const t of types) { const n = m_all_nodes.find(nd => nd.type === t); if (n) { map[t] = n.color; } }
    m_vscode.postMessage({ type: 'updateSetting', key: 'graphNodeColors', value: map });
}

function attachSettingsEvents(): void {
    if (!settings_panel) { return; }

    // Collapsible sections
    settings_panel.querySelectorAll('.settings-title[data-collapse]').forEach(el => {
        el.addEventListener('click', () => {
            const sid = (el as HTMLElement).dataset.collapse!;
            const content = settings_panel!.querySelector(`#sc-${sid}`) as HTMLElement | null;
            if (!content) { return; }
            const collapsed = content.style.display === 'none';
            content.style.display = collapsed ? 'flex' : 'none';
            m_settings_collapse_state[sid] = !collapsed;
            (el as HTMLElement).textContent = (!collapsed ? '\u25B6' : '\u25BC') + ' ' + (el as HTMLElement).textContent!.substring(2);
            m_vscode.postMessage({ type: 'updateSetting', key: 'graphSettingsCollapse', value: { ...m_settings_collapse_state } });
        });
    });

    const input_keys: Record<string, string> = {
        's-repulsion': 'graphSimRepulsion', 's-attraction': 'graphSimAttraction', 's-gravity': 'graphSimGravity',
        's-linkLength': 'graphSimLinkLength', 's-minDist': 'graphSimMinDistance', 's-steps': 'graphSimStepsPerFrame',
        's-threshold': 'graphSimThreshold', 's-damping': 'graphSimDamping', 's-taperedWidth': 'graphTaperedWidth',
    };

    // Edge style
    const es = settings_panel.querySelector('#s-edgeStyle') as HTMLSelectElement;
    es.addEventListener('change', () => { m_edge_style = es.value as EdgeStyle; m_vscode.postMessage({ type: 'updateSetting', key: 'graphEdgeStyle', value: m_edge_style }); draw(); });

    // Edge direction
    const ed = settings_panel.querySelector('#s-edgeDirection') as HTMLSelectElement;
    ed.addEventListener('change', () => applyEdgeDirection(ed.value as EdgeDirection, 's-edgeDirection'));

    // Auto-pause
    const ap = settings_panel.querySelector('#s-autoPause') as HTMLInputElement;
    ap.addEventListener('change', () => { m_auto_pause_during_drag = ap.checked; m_vscode.postMessage({ type: 'updateSetting', key: 'graphAutoPauseDrag', value: m_auto_pause_during_drag }); });

    // Minimap
    const mm = settings_panel.querySelector('#s-minimap') as HTMLInputElement;
    mm.addEventListener('change', () => { m_minimap_enabled = mm.checked; m_vscode.postMessage({ type: 'updateSetting', key: 'graphMinimap', value: m_minimap_enabled }); draw(); });

    // 3D mode
    const mode3d = settings_panel.querySelector('#s-3dmode') as HTMLInputElement;
    mode3d.addEventListener('change', () => { toggle3DMode(); mode3d.checked = m_3d_mode; });

    // Number inputs
    settings_panel.querySelectorAll<HTMLInputElement>('input[type="number"][data-simkey]').forEach(input => {
        const sk = input.dataset.simkey as keyof SimVars;
        input.addEventListener('change', () => {
            const raw = parseFloat(input.value);
            if (isNaN(raw)) { input.value = String(m_sim_vars[sk]); return; }
            const clamped = clampSimVar(sk, raw);
            m_sim_vars[sk] = sk === 'stepsPerFrame' ? Math.round(clamped) : clamped;
            input.value = String(m_sim_vars[sk]);
            const key = input_keys[input.id];
            if (key) { m_vscode.postMessage({ type: 'updateSetting', key, value: m_sim_vars[sk] }); }
            startSimulation();
        });
    });

    // Color pickers
    const ptypes = new Set(m_all_nodes.map(n => n.type));
    for (const type of ptypes) {
        const p = settings_panel?.querySelector(`#s-color-${type}`) as HTMLInputElement | null;
        if (p) { p.addEventListener('input', () => applyNodeColor(type, p.value)); }
    }

    // Reset buttons
    settings_panel.querySelectorAll<HTMLButtonElement>('.settings-reset-btn[data-defkey]').forEach(btn => {
        btn.addEventListener('click', () => {
            const dk = btn.dataset.defkey!;
            const dv = m_provider_defaults[dk];
            if (dv === undefined) { return; }
            const row = btn.closest('.settings-row, .settings-row-inline');
            if (!row) { return; }
            const ni = row.querySelector<HTMLInputElement>('input[type="number"]');
            if (ni) {
                const sk = ni.dataset.simkey as keyof SimVars;
                const c = clampSimVar(sk, dv);
                m_sim_vars[sk] = sk === 'stepsPerFrame' ? Math.round(c) : c;
                ni.value = String(m_sim_vars[sk]);
                const key = input_keys[ni.id];
                if (key) { m_vscode.postMessage({ type: 'updateSetting', key, value: m_sim_vars[sk] }); }
                startSimulation();
                return;
            }
            const sel = row.querySelector<HTMLSelectElement>('select');
            if (sel) { sel.value = String(dv); sel.dispatchEvent(new Event('change')); return; }
            const cb = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
            if (cb) { cb.checked = !!dv; cb.dispatchEvent(new Event('change')); return; }
            if (dk === 'simEnabled') {
                m_sim_enabled = !!dv;
                if (m_sim_enabled) { startSimulation(); } else { stopSimulation(); }
                updateStartStopBtn();
                m_vscode.postMessage({ type: 'updateSetting', key: 'graphSimEnabled', value: m_sim_enabled });
            }
        });
    });

    // Color reset
    settings_panel.querySelectorAll<HTMLButtonElement>('.settings-reset-btn[data-resetcolor]').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.resetcolor!;
            const dc = m_provider_defaults.nodeColors?.[type];
            if (!dc) { return; }
            const p = settings_panel!.querySelector(`#s-color-${type}`) as HTMLInputElement | null;
            if (p) { p.value = dc; }
            applyNodeColor(type, dc);
        });
    });

    // Start/Stop
    (settings_panel.querySelector('#s-startstop') as HTMLButtonElement).addEventListener('click', startStopSimulation);

    // Restart
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
    // In 3D mode, composite the WebGL canvas and the overlay canvas
    const overlay = m_canvas.parentElement!.querySelector('canvas[data-overlay]') as HTMLCanvasElement | null;
    if (overlay) {
        const tmp = document.createElement('canvas');
        tmp.width = m_canvas.width;
        tmp.height = m_canvas.height;
        const tc = tmp.getContext('2d')!;
        tc.drawImage(m_canvas, 0, 0);
        tc.drawImage(overlay, 0, 0);
        m_vscode.postMessage({ type: 'saveScreenshot', dataUri: tmp.toDataURL('image/png') });
    } else {
        m_vscode.postMessage({ type: 'saveScreenshot', dataUri: m_canvas.toDataURL('image/png') });
    }
}

// ------------------------------------------------------------
// Apply settings from provider
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
    if (aS.mode3d !== undefined) { m_3d_mode = aS.mode3d; }
}

// ------------------------------------------------------------
// Message listener
// ------------------------------------------------------------
window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data;
    switch (msg.type) {
        case 'update':
            if (msg.defaults) { m_provider_defaults = msg.defaults; }
            if (msg.settings) { applySettingsFromProvider(msg.settings); }
            createGraph(msg.nodes as GraphNode[], msg.edges as GraphEdge[]);
            break;
        case 'showSettings':
            toggleSettings();
            break;
        case 'screenshot':
            takeScreenshot();
            break;
        case 'toggleLayout':
            for (const ln of m_layout_nodes) { ln.vx = 0; ln.vy = 0; ln.vz = 0; }
            startSimulation();
            break;
        case 'focusNode':
            focusOnNode(msg.targetId as string);
            break;
        case 'exportCsv': {
            const nm = new Map(m_all_nodes.map(n => [n.id, n]));
            const visible = new Set(m_all_nodes.filter(n => !isNodeFiltered(n)).map(n => n.id));
            const rows: { node_a: string; type_a: string; link_type: string; node_b: string; type_b: string }[] = [];
            for (const e of m_all_edges) {
                if (!visible.has(e.from) || !visible.has(e.to)) { continue; }
                const na = nm.get(e.from), nb = nm.get(e.to);
                if (!na || !nb) { continue; }
                const src = m_edge_direction === EdgeDirection.IS_USING ? na : nb;
                const dst = m_edge_direction === EdgeDirection.IS_USING ? nb : na;
                rows.push({ node_a: src.label, type_a: src.type, link_type: m_edge_direction === EdgeDirection.IS_USING ? 'uses' : 'used_by', node_b: dst.label, type_b: dst.type });
            }
            m_vscode.postMessage({ type: 'csvData', rows });
            break;
        }
    }
});

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------
m_vscode.postMessage({ type: 'ready' });
