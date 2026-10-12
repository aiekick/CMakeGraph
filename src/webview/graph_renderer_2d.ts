// ------------------------------------------------------------
// 2D Graph Renderer — implements IGraphRenderer.
// Handles: 2D camera (pan+zoom), Canvas 2D drawing, hit testing,
// mouse/keyboard events, minimap.
// ------------------------------------------------------------

import {
    EdgeDirection, EdgeStyle,
    GRID_SIZE, NODE_H, ZOOM_MIN, ZOOM_MAX,
    type CameraState, type CameraState2D,
    type GraphEdge, type GraphNode, type GraphState,
    type IGraphRenderer, type LayoutNode, type RendererCallbacks,
} from './types';
import {
    getCssVar, isLightTheme, themeFg, themeEdgeColor, drawNodeBox,
} from './utils';

// Minimap constants
const MINIMAP_W = 150;
const MINIMAP_H = 100;
const MINIMAP_MARGIN = 8;

export class Graph2DRenderer implements IGraphRenderer {
    private m_canvas: HTMLCanvasElement | null = null;
    private m_ctx: CanvasRenderingContext2D | null = null;
    private m_callbacks: RendererCallbacks | null = null;

    // Camera
    private m_cam_x = 0;
    private m_cam_y = 0;
    private m_zoom = 1;

    // Interaction state
    private m_is_panning = false;
    private m_is_dragging_node = false;
    private m_was_panning = false;
    private m_drag_node: LayoutNode | null = null;
    private m_pan_start_x = 0;
    private m_pan_start_y = 0;
    private m_cam_start_x = 0;
    private m_cam_start_y = 0;
    private m_drag_offset_x = 0;
    private m_drag_offset_y = 0;

    // Minimap interaction
    private m_minimap_transform: {
        mx: number; my: number; scale: number;
        wMinX: number; wMinY: number;
    } | null = null;
    private m_is_dragging_minimap = false;

    // Stored references to current data (updated each draw() call)
    private m_nodes: LayoutNode[] = [];
    private m_state: GraphState | null = null;

    // Event handler references for cleanup
    private m_boundMouseMove = (e: MouseEvent) => this.handleMouseMove(e);
    private m_boundMouseUp = (e: MouseEvent) => this.handleMouseUp(e);

    // ---- IGraphRenderer: Lifecycle ----

    init(aCanvas: HTMLCanvasElement): void {
        this.m_canvas = aCanvas;
        this.m_ctx = aCanvas.getContext('2d')!;
    }

    dispose(): void {
        this.detachEvents();
        this.m_canvas = null;
        this.m_ctx = null;
    }

    // ---- IGraphRenderer: Camera ----

    saveCamera(): CameraState {
        return { kind: '2d', camX: this.m_cam_x, camY: this.m_cam_y, zoom: this.m_zoom };
    }

    restoreCamera(aState: CameraState): boolean {
        if (aState.kind !== '2d') { return false; }
        const s = aState as CameraState2D;
        this.m_cam_x = s.camX;
        this.m_cam_y = s.camY;
        this.m_zoom = s.zoom;
        return true;
    }

    worldToScreen(aNode: LayoutNode): [number, number] {
        return [this.m_cam_x + aNode.x * this.m_zoom, this.m_cam_y + aNode.y * this.m_zoom];
    }

    centerOnNodes(aNodes: LayoutNode[], aIsFiltered: (n: GraphNode) => boolean): void {
        if (!this.m_canvas || aNodes.length === 0) { return; }
        const b = this.computeBounds(aNodes, aIsFiltered);
        if (b.count === 0) { return; }
        const bw = b.maxX - b.minX;
        const bh = b.maxY - b.minY;
        const cw = this.m_canvas.clientWidth;
        const ch = this.m_canvas.clientHeight;
        const pad = 40;
        this.m_zoom = Math.max(ZOOM_MIN, Math.min(2, Math.min(
            (cw - pad * 2) / Math.max(1, bw),
            (ch - pad * 2) / Math.max(1, bh),
        )));
        this.m_cam_x = cw / 2 - ((b.minX + b.maxX) / 2) * this.m_zoom;
        this.m_cam_y = ch / 2 - ((b.minY + b.maxY) / 2) * this.m_zoom;
    }

    // ---- IGraphRenderer: Drag state ----

    isDraggingNode(): boolean { return this.m_is_dragging_node; }
    getDragNode(): LayoutNode | null { return this.m_drag_node; }

    // ---- IGraphRenderer: Hit testing ----

    hitTestNode(aPosX: number, aPosY: number, aNodes: LayoutNode[], aIsFiltered: (n: GraphNode) => boolean): LayoutNode | null {
        for (let i = aNodes.length - 1; i >= 0; i--) {
            const ln = aNodes[i];
            if (aIsFiltered(ln.node)) { continue; }
            const sx = this.m_cam_x + ln.x * this.m_zoom;
            const sy = this.m_cam_y + ln.y * this.m_zoom;
            const hw = (ln.w * this.m_zoom) / 2;
            const hh = (NODE_H * this.m_zoom) / 2;
            if (aPosX >= sx - hw && aPosX <= sx + hw && aPosY >= sy - hh && aPosY <= sy + hh) {
                return ln;
            }
        }
        return null;
    }

    // ---- IGraphRenderer: Drawing ----

    draw(aNodes: LayoutNode[], aEdges: GraphEdge[], aState: GraphState): void {
        // Store references for event handlers
        this.m_nodes = aNodes;
        this.m_state = aState;

        if (!this.m_canvas || !this.m_ctx) { return; }
        const w = this.m_canvas.clientWidth;
        const h = this.m_canvas.clientHeight;
        const ctx = this.m_ctx;

        ctx.clearRect(0, 0, w, h);
        const bg = getCssVar('--vscode-editor-background') || (isLightTheme() ? '#ffffff' : '#1e1e1e');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);

        this.drawGrid(ctx, w, h);
        this.drawEdges(ctx, w, h, aNodes, aEdges, aState);
        this.drawNodes(ctx, w, h, aNodes, aState);
        if (aState.minimapEnabled) { this.drawMinimap(ctx, w, h, aNodes, aEdges, aState); }
    }

    // ---- IGraphRenderer: Events ----

    attachEvents(aCanvas: HTMLCanvasElement, aCallbacks: RendererCallbacks): void {
        this.m_callbacks = aCallbacks;
        aCanvas.addEventListener('keydown', this.handleKeyDown);
        aCanvas.addEventListener('keyup', this.handleKeyUp);
        aCanvas.addEventListener('mousedown', this.handleMouseDown);
        aCanvas.addEventListener('dblclick', this.handleDblClick);
        aCanvas.addEventListener('wheel', this.handleWheel, { passive: false });
        window.addEventListener('mousemove', this.m_boundMouseMove);
        window.addEventListener('mouseup', this.m_boundMouseUp);
        aCanvas.style.cursor = 'grab';
    }

    detachEvents(): void {
        if (this.m_canvas) {
            this.m_canvas.removeEventListener('keydown', this.handleKeyDown);
            this.m_canvas.removeEventListener('keyup', this.handleKeyUp);
            this.m_canvas.removeEventListener('mousedown', this.handleMouseDown);
            this.m_canvas.removeEventListener('dblclick', this.handleDblClick);
            this.m_canvas.removeEventListener('wheel', this.handleWheel);
        }
        window.removeEventListener('mousemove', this.m_boundMouseMove);
        window.removeEventListener('mouseup', this.m_boundMouseUp);
        this.m_callbacks = null;
    }

    // ================================================================
    // Private: Drawing
    // ================================================================

    private wts(wx: number, wy: number): [number, number] {
        return [this.m_cam_x + wx * this.m_zoom, this.m_cam_y + wy * this.m_zoom];
    }

    private stw(sx: number, sy: number): [number, number] {
        return [(sx - this.m_cam_x) / this.m_zoom, (sy - this.m_cam_y) / this.m_zoom];
    }

    // ---- Grid ----

    private drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
        const gs = GRID_SIZE * this.m_zoom;
        if (gs < 4) { return; }
        const [wl, wt] = this.stw(0, 0);
        const [wr, wb] = this.stw(w, h);
        const sx = Math.floor(wl / GRID_SIZE) * GRID_SIZE;
        const sy = Math.floor(wt / GRID_SIZE) * GRID_SIZE;
        const alpha = Math.min(0.3, gs / 100);
        ctx.strokeStyle = themeEdgeColor(alpha);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let wx = sx; wx <= wr; wx += GRID_SIZE) { const x = this.m_cam_x + wx * this.m_zoom; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
        for (let wy = sy; wy <= wb; wy += GRID_SIZE) { const y = this.m_cam_y + wy * this.m_zoom; ctx.moveTo(0, y); ctx.lineTo(w, y); }
        ctx.stroke();
        // Origin cross
        ctx.strokeStyle = themeEdgeColor(0.5);
        ctx.lineWidth = 2;
        if (this.m_cam_x >= 0 && this.m_cam_x <= w) { ctx.beginPath(); ctx.moveTo(this.m_cam_x, 0); ctx.lineTo(this.m_cam_x, h); ctx.stroke(); }
        if (this.m_cam_y >= 0 && this.m_cam_y <= h) { ctx.beginPath(); ctx.moveTo(0, this.m_cam_y); ctx.lineTo(w, this.m_cam_y); ctx.stroke(); }
    }

    // ---- Edges ----

    private drawEdges(ctx: CanvasRenderingContext2D, w: number, h: number, nodes: LayoutNode[], edges: GraphEdge[], s: GraphState): void {
        if (edges.length === 0) { return; }
        const nm = new Map<string, LayoutNode>();
        for (const ln of nodes) { if (!s.isNodeFiltered(ln.node)) { nm.set(ln.node.id, ln); } }

        // Normal edges
        for (const e of edges) {
            const f = nm.get(e.from), t = nm.get(e.to);
            if (!f || !t) { continue; }
            if (s.selectedNodeId && (e.from === s.selectedNodeId || e.to === s.selectedNodeId)) { continue; }
            const [x1, y1] = this.wts(f.x, f.y);
            const [x2, y2] = this.wts(t.x, t.y);
            const m = 50;
            if (Math.max(x1, x2) < -m || Math.min(x1, x2) > w + m) { continue; }
            if (Math.max(y1, y2) < -m || Math.min(y1, y2) > h + m) { continue; }
            const ea = (s.isNodeDimmed(f.node) && s.isNodeDimmed(t.node)) ? 0.04 : 0.15;
            this.drawEdgeStyled(ctx, x1, y1, x2, y2, themeEdgeColor(ea), 1, s);
        }

        // Highlighted edges
        if (s.selectedNodeId) {
            for (const e of edges) {
                if (e.from !== s.selectedNodeId && e.to !== s.selectedNodeId) { continue; }
                const f = nm.get(e.from), t = nm.get(e.to);
                if (!f || !t) { continue; }
                const [x1, y1] = this.wts(f.x, f.y);
                const [x2, y2] = this.wts(t.x, t.y);
                let sx1 = x1, sy1 = y1, sx2 = x2, sy2 = y2;
                let base = f;
                if (s.edgeDirection === EdgeDirection.USED_BY) { sx1 = x2; sy1 = y2; sx2 = x1; sy2 = y1; base = t; }
                const grad = ctx.createLinearGradient(sx1, sy1, sx2, sy2);
                grad.addColorStop(0, base.node.color);
                grad.addColorStop(1, themeFg());
                this.drawEdgeStyled(ctx, x1, y1, x2, y2, grad, 0.6, s);
            }
        }
    }

    private drawEdgeStyled(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string | CanvasGradient, alpha: number, s: GraphState): void {
        let sx1 = x1, sy1 = y1, sx2 = x2, sy2 = y2;
        if (s.edgeDirection === EdgeDirection.USED_BY) { sx1 = x2; sy1 = y2; sx2 = x1; sy2 = y1; }
        switch (s.edgeStyle) {
            case EdgeStyle.TAPERED: this.drawTapered(ctx, sx1, sy1, sx2, sy2, color, alpha, s.simVars.taperedWidth); break;
            case EdgeStyle.CHEVRONS: this.drawChevrons(ctx, sx1, sy1, sx2, sy2, color, alpha); break;
            case EdgeStyle.LINE: this.drawLine(ctx, sx1, sy1, sx2, sy2, color, alpha); break;
        }
    }

    private drawTapered(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string | CanvasGradient, alpha: number, tw: number): void {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 2) { return; }
        const px = -dy / len, py = dx / len;
        const wh = Math.max(1.5, 3 * this.m_zoom * tw);
        const nh = Math.max(0.3, 0.5 * this.m_zoom * tw);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x1 + px * wh, y1 + py * wh);
        ctx.lineTo(x2 + px * nh, y2 + py * nh);
        ctx.lineTo(x2 - px * nh, y2 - py * nh);
        ctx.lineTo(x1 - px * wh, y1 - py * wh);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    private drawChevrons(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string | CanvasGradient, alpha: number): void {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 2) { return; }
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, 1.5 * this.m_zoom);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        const ux = dx / len, uy = dy / len;
        const cs = Math.max(3, 5 * this.m_zoom);
        const g = Math.max(2, 4 * this.m_zoom);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        ctx.lineWidth = Math.max(1, 1.2 * this.m_zoom);
        for (let i = -1; i <= 1; i++) {
            const cx = mx + ux * i * g, cy = my + uy * i * g;
            ctx.beginPath();
            ctx.moveTo(cx - ux * cs - uy * cs, cy - uy * cs + ux * cs);
            ctx.lineTo(cx, cy);
            ctx.lineTo(cx - ux * cs + uy * cs, cy - uy * cs - ux * cs);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    private drawLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string | CanvasGradient, alpha: number): void {
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, 1.5 * this.m_zoom);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.globalAlpha = 1;
    }

    // ---- Nodes ----

    private drawNodes(ctx: CanvasRenderingContext2D, w: number, h: number, nodes: LayoutNode[], s: GraphState): void {
        for (const ln of nodes) {
            if (s.isNodeFiltered(ln.node)) { continue; }
            const [sx, sy] = this.wts(ln.x, ln.y);
            const sw = ln.w * this.m_zoom;
            const sh = NODE_H * this.m_zoom;
            if ((sx + sw / 2) < 0 || (sx - sw / 2) > w || (sy + sh / 2) < 0 || (sy - sh / 2) > h) { continue; }
            drawNodeBox(ctx, sx, sy, sw, sh, this.m_zoom, ln.node,
                s.isNodeDimmed(ln.node) ? 0.12 : 1,
                ln.node.id === s.selectedNodeId, ln.pinned,
                s.focusedNodeId !== null && ln.node.id === s.focusedNodeId);
        }
    }

    // ---- Minimap ----

    private drawMinimap(ctx: CanvasRenderingContext2D, cw: number, ch: number, nodes: LayoutNode[], edges: GraphEdge[], s: GraphState): void {
        if (nodes.length === 0) { return; }
        const b = this.computeBounds(nodes, s.isNodeFiltered);
        if (b.count === 0) { return; }
        const ww = b.maxX - b.minX || 1, wh = b.maxY - b.minY || 1;
        const pad = Math.max(ww, wh) * 0.05;
        const wmx = b.minX - pad, wmy = b.minY - pad;
        const scale = Math.min(MINIMAP_W / (ww + pad * 2), MINIMAP_H / (wh + pad * 2));
        const mx = MINIMAP_MARGIN, my = ch - MINIMAP_H - MINIMAP_MARGIN;
        this.m_minimap_transform = { mx, my, scale, wMinX: wmx, wMinY: wmy };

        const mm_bg = getCssVar('--vscode-sideBar-background') || getCssVar('--vscode-editor-background') || '#1e1e1e';
        ctx.fillStyle = mm_bg; ctx.globalAlpha = 0.9;
        ctx.fillRect(mx, my, MINIMAP_W, MINIMAP_H);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = getCssVar('--vscode-panel-border') || 'rgba(128,128,128,0.5)';
        ctx.lineWidth = 1; ctx.strokeRect(mx, my, MINIMAP_W, MINIMAP_H);

        // Edges
        ctx.strokeStyle = themeEdgeColor(0.15); ctx.lineWidth = 0.5;
        const nm = new Map<string, LayoutNode>();
        for (const ln of nodes) { if (!s.isNodeFiltered(ln.node)) { nm.set(ln.node.id, ln); } }
        for (const e of edges) {
            const f = nm.get(e.from), t = nm.get(e.to);
            if (!f || !t) { continue; }
            ctx.beginPath();
            ctx.moveTo(mx + (f.x - wmx) * scale, my + (f.y - wmy) * scale);
            ctx.lineTo(mx + (t.x - wmx) * scale, my + (t.y - wmy) * scale);
            ctx.stroke();
        }

        // Nodes
        for (const ln of nodes) {
            if (s.isNodeFiltered(ln.node)) { continue; }
            const dim = s.isNodeDimmed(ln.node);
            ctx.globalAlpha = dim ? 0.15 : 1;
            ctx.fillStyle = ln.node.id === s.selectedNodeId ? themeFg() : ln.node.color;
            const ds = Math.max(2, ln.w * scale * 0.3);
            const nx = mx + (ln.x - wmx) * scale, ny = my + (ln.y - wmy) * scale;
            ctx.fillRect(nx - ds / 2, ny - ds / 2, ds, ds);
        }
        ctx.globalAlpha = 1;

        // Viewport rect
        const [vwl, vwt] = this.stw(0, 0);
        const [vwr, vwb] = this.stw(cw, ch);
        const vx = mx + (vwl - wmx) * scale, vy = my + (vwt - wmy) * scale;
        const vw = (vwr - vwl) * scale, vh = (vwb - vwt) * scale;
        ctx.strokeStyle = 'rgba(255,200,50,0.8)'; ctx.lineWidth = 1.5;
        const cx = Math.max(mx, vx), cy = Math.max(my, vy);
        const cr = Math.min(mx + MINIMAP_W, vx + vw), cb = Math.min(my + MINIMAP_H, vy + vh);
        if (cr > cx && cb > cy) { ctx.strokeRect(cx, cy, cr - cx, cb - cy); }
    }

    // ================================================================
    // Private: Event Handlers
    // ================================================================

    private handleKeyDown = (e: KeyboardEvent): void => {
        if (e.key === ' ') { e.preventDefault(); }
    };

    private handleKeyUp = (e: KeyboardEvent): void => {
        if (e.key === ' ') { e.preventDefault(); this.m_callbacks?.onStartStopSimulation(); }
    };

    private handleMouseDown = (e: MouseEvent): void => {
        if (e.button !== 0 || !this.m_canvas || !this.m_state || !this.m_callbacks) { return; }
        e.preventDefault();
        this.m_canvas.focus();
        const rect = this.m_canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;

        // Minimap
        if (this.isInMinimap(mx, my)) {
            this.m_is_dragging_minimap = true;
            this.minimapPanTo(mx, my);
            this.m_canvas.style.cursor = 'crosshair';
            return;
        }

        // Hit test
        const hit = this.hitTestNode(mx, my, this.m_nodes, this.m_state.isNodeFiltered);
        if (hit) {
            this.m_is_dragging_node = true;
            this.m_drag_node = hit;
            const [sx, sy] = this.wts(hit.x, hit.y);
            this.m_drag_offset_x = mx - sx;
            this.m_drag_offset_y = my - sy;
            this.m_canvas.style.cursor = 'move';
            this.m_callbacks.onNodeClick(hit);
            this.m_callbacks.onNodeDragStart(hit);
        } else {
            this.m_is_panning = true;
            this.m_pan_start_x = e.clientX;
            this.m_pan_start_y = e.clientY;
            this.m_cam_start_x = this.m_cam_x;
            this.m_cam_start_y = this.m_cam_y;
            this.m_canvas.style.cursor = 'grabbing';
        }
        this.m_callbacks.onRequestDraw();
    };

    private handleMouseMove(e: MouseEvent): void {
        window.focus();
        if (!this.m_canvas) { return; }
        if (this.m_is_dragging_minimap) {
            const rect = this.m_canvas.getBoundingClientRect();
            this.minimapPanTo(e.clientX - rect.left, e.clientY - rect.top);
            return;
        }
        if (this.m_is_dragging_node && this.m_drag_node) {
            const rect = this.m_canvas.getBoundingClientRect();
            const [wx, wy] = this.stw(e.clientX - rect.left - this.m_drag_offset_x, e.clientY - rect.top - this.m_drag_offset_y);
            this.m_drag_node.x = wx;
            this.m_drag_node.y = wy;
            this.m_callbacks?.onRequestDraw();
        } else if (this.m_is_panning) {
            this.m_was_panning = true;
            this.m_cam_x = this.m_cam_start_x + (e.clientX - this.m_pan_start_x);
            this.m_cam_y = this.m_cam_start_y + (e.clientY - this.m_pan_start_y);
            this.m_callbacks?.onRequestDraw();
        }
    }

    private handleMouseUp(e: MouseEvent): void {
        if (e.button !== 0 || !this.m_canvas) { return; }
        if (this.m_is_dragging_minimap) {
            this.m_is_dragging_minimap = false;
            this.m_canvas.style.cursor = 'grab';
            return;
        }
        if (this.m_is_dragging_node) {
            this.m_is_dragging_node = false;
            this.m_drag_node = null;
            this.m_canvas.style.cursor = 'grab';
            this.m_callbacks?.onNodeDragEnd();
        } else if (!this.m_was_panning && e.target === this.m_canvas) {
            this.m_callbacks?.onBackgroundClick();
        }
        if (this.m_is_panning) {
            this.m_is_panning = false;
            this.m_was_panning = false;
            this.m_canvas.style.cursor = 'grab';
            this.m_callbacks?.onCameraChanged();
        }
    }

    private handleDblClick = (e: MouseEvent): void => {
        if (!this.m_canvas || !this.m_callbacks || !this.m_state) { return; }
        window.focus();
        const rect = this.m_canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        if (this.isInMinimap(mx, my)) { return; }
        if (this.m_state.selectedNodeId) {
            this.m_callbacks.onDoubleClickNode(this.m_state.selectedNodeId, e.ctrlKey || e.metaKey);
        } else {
            this.m_callbacks.onDoubleClickBackground();
        }
    };

    private handleWheel = (e: WheelEvent): void => {
        if (!this.m_canvas) { return; }
        e.preventDefault();
        window.focus();
        const rect = this.m_canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;

        if (this.isInMinimap(mx, my) && this.m_minimap_transform) {
            const t = this.m_minimap_transform;
            const wx = (mx - t.mx) / t.scale + t.wMinX;
            const wy = (my - t.my) / t.scale + t.wMinY;
            const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            this.m_zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.m_zoom * f));
            this.m_cam_x = this.m_canvas.clientWidth / 2 - wx * this.m_zoom;
            this.m_cam_y = this.m_canvas.clientHeight / 2 - wy * this.m_zoom;
            this.m_callbacks?.onCameraChanged();
            this.m_callbacks?.onRequestDraw();
            return;
        }

        const [wxb, wyb] = this.stw(mx, my);
        const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        this.m_zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.m_zoom * f));
        this.m_cam_x = mx - wxb * this.m_zoom;
        this.m_cam_y = my - wyb * this.m_zoom;
        this.m_callbacks?.onCameraChanged();
        this.m_callbacks?.onRequestDraw();
    };

    // ---- Minimap helpers ----

    private isInMinimap(sx: number, sy: number): boolean {
        if (!this.m_minimap_transform) { return false; }
        const { mx, my } = this.m_minimap_transform;
        return sx >= mx && sx <= mx + MINIMAP_W && sy >= my && sy <= my + MINIMAP_H;
    }

    private minimapPanTo(sx: number, sy: number): void {
        if (!this.m_minimap_transform || !this.m_canvas) { return; }
        const { mx, my, scale, wMinX, wMinY } = this.m_minimap_transform;
        const wx = (sx - mx) / scale + wMinX;
        const wy = (sy - my) / scale + wMinY;
        this.m_cam_x = this.m_canvas.clientWidth / 2 - wx * this.m_zoom;
        this.m_cam_y = this.m_canvas.clientHeight / 2 - wy * this.m_zoom;
        this.m_callbacks?.onCameraChanged();
        this.m_callbacks?.onRequestDraw();
    }

    // ---- Bounds ----

    private computeBounds(nodes: LayoutNode[], isFiltered: (n: GraphNode) => boolean): { minX: number; minY: number; maxX: number; maxY: number; count: number } {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
        for (const ln of nodes) {
            if (isFiltered(ln.node)) { continue; }
            minX = Math.min(minX, ln.x - ln.w / 2);
            maxX = Math.max(maxX, ln.x + ln.w / 2);
            minY = Math.min(minY, ln.y - NODE_H / 2);
            maxY = Math.max(maxY, ln.y + NODE_H / 2);
            count++;
        }
        return { minX, minY, maxX, maxY, count };
    }
}
