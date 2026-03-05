// ------------------------------------------------------------
// Shared types, interfaces and constants for the graph webview.
// This file is the single source of truth — both renderers,
// simulations and the orchestrator import from here.
// ------------------------------------------------------------

// Edge direction / Edge style enums
// Must stay in sync with WorkspaceConfig.Graph.* in config/workspace/types.ts

export const enum EdgeDirection {
    USED_BY = 'used-by',
    IS_USING = 'is-using',
}

export const enum EdgeStyle {
    TAPERED = 'tapered',
    CHEVRONS = 'chevrons',
    LINE = 'line',
}

// ------------------------------------------------------------
// Data types
// ------------------------------------------------------------

export interface GraphNode {
    id: string;
    label: string;
    type: string;
    color: string;
    shape: string;
    sourcePath: string;
}

export interface GraphEdge {
    from: string;
    to: string;
}

export interface LayoutNode {
    node: GraphNode;
    x: number;   // world position (center)
    y: number;
    z: number;   // 3D world position (0 in 2D mode)
    w: number;   // node width (computed from label)
    vx: number;  // velocity for force simulation
    vy: number;
    vz: number;  // 3D velocity (0 in 2D mode)
    mass: number; // mass for force simulation
    pinned: boolean; // if true, simulation forces are ignored (can still be dragged)
}

// ------------------------------------------------------------
// Simulation parameters
// ------------------------------------------------------------

export interface SimVars {
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
export const SIM_CLAMP: Record<keyof SimVars, [number, number]> = {
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

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

export const NODE_H = 25;
export const NODE_PAD_X = 10;
export const NODE_MIN_W = 60;
export const GRID_SIZE = 40;
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 10;

export const TARGET_TYPES = [
    'EXECUTABLE', 'STATIC_LIBRARY', 'SHARED_LIBRARY',
    'MODULE_LIBRARY', 'OBJECT_LIBRARY', 'INTERFACE_LIBRARY',
    'SYSTEM_LIBRARY',
];

// ------------------------------------------------------------
// Camera state (union for 2D / 3D persistence)
// ------------------------------------------------------------

export interface CameraState2D {
    kind: '2d';
    camX: number;
    camY: number;
    zoom: number;
}

export interface CameraState3D {
    kind: '3d';
    camYaw: number;
    camPitch: number;
    camDistance: number;
    targetX?: number;
    targetY?: number;
    targetZ?: number;
}

export type CameraState = CameraState2D | CameraState3D;

// ------------------------------------------------------------
// Persisted state (survives webview refresh via vscode setState)
// ------------------------------------------------------------

export interface PersistedState {
    camX?: number;
    camY?: number;
    zoom?: number;
    mode3d?: boolean;
    camYaw?: number;
    camPitch?: number;
    camDistance?: number;
    camTargetX?: number;
    camTargetY?: number;
    camTargetZ?: number;
    // Saved camera for the OTHER mode (so toggling restores the previous view)
    savedCamera2d?: { camX: number; camY: number; zoom: number };
    savedCamera3d?: { camYaw: number; camPitch: number; camDistance: number; targetX: number; targetY: number; targetZ: number };
}

// ------------------------------------------------------------
// Graph state passed to the renderer for drawing
// ------------------------------------------------------------

export interface GraphState {
    selectedNodeId: string | null;
    focusedNodeId: string | null;
    edgeStyle: EdgeStyle;
    edgeDirection: EdgeDirection;
    simVars: SimVars;
    minimapEnabled: boolean;
    searchFilter: string;
    searchMode: 'name' | 'path';
    searchFilterMode: 'dim' | 'hide';
    isNodeFiltered: (node: GraphNode) => boolean;
    isNodeDimmed: (node: GraphNode) => boolean;
    focusVisibleIds: Set<string> | null;
}

// ------------------------------------------------------------
// Renderer callbacks (renderer → orchestrator)
// ------------------------------------------------------------

export interface RendererCallbacks {
    onNodeClick: (node: LayoutNode) => void;
    onNodeDragStart: (node: LayoutNode) => void;
    onNodeDragEnd: () => void;
    onBackgroundClick: () => void;
    onDoubleClickNode: (nodeId: string, ctrlKey: boolean) => void;
    onDoubleClickBackground: () => void;
    onRequestDraw: () => void;
    onCameraChanged: () => void;
    onStartStopSimulation: () => void;
}

// ------------------------------------------------------------
// IGraphRenderer interface
// ------------------------------------------------------------

export interface IGraphRenderer {
    // Lifecycle
    init(canvas: HTMLCanvasElement): void;
    dispose(): void;

    // Rendering
    draw(nodes: LayoutNode[], edges: GraphEdge[], state: GraphState): void;

    // Camera
    centerOnNodes(nodes: LayoutNode[], isFiltered: (n: GraphNode) => boolean): void;
    saveCamera(): CameraState;
    restoreCamera(state: CameraState): boolean;

    // Coordinate transforms (for footer/external display)
    worldToScreen(node: LayoutNode): [number, number];

    // Hit testing
    hitTestNode(sx: number, sy: number, nodes: LayoutNode[], isFiltered: (n: GraphNode) => boolean): LayoutNode | null;

    // Interaction events
    attachEvents(canvas: HTMLCanvasElement, callbacks: RendererCallbacks): void;
    detachEvents(): void;

    // Drag state (needed by orchestrator for simulation pause)
    isDraggingNode(): boolean;
    getDragNode(): LayoutNode | null;
}

// ------------------------------------------------------------
// ISimulation interface
// ------------------------------------------------------------

export interface ISimulation {
    /**
     * Run one simulation step. Returns total energy.
     * The orchestrator calls this in a requestAnimationFrame loop.
     */
    step(
        nodes: LayoutNode[],
        edges: GraphEdge[],
        vars: SimVars,
        isFiltered: (n: GraphNode) => boolean,
        dragNode: LayoutNode | null,
        pinnedCheck: (n: LayoutNode) => boolean,
    ): number;
}
