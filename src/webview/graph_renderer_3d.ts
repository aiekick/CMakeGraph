// ------------------------------------------------------------
// 3D Graph Renderer — implements IGraphRenderer.
// Hybrid: WebGL for grid + edges, Canvas 2D overlay for nodes/text.
// Turntable camera via 4x4 MVP matrices.
// Middle-click pan, middle-click-node centers orbit.
// ------------------------------------------------------------

import {
    EdgeDirection, EdgeStyle,
    NODE_H,
    type CameraState, type CameraState3D,
    type GraphEdge, type GraphNode, type GraphState,
    type IGraphRenderer, type LayoutNode, type RendererCallbacks,
} from './types';
import {
    getCssVar, isLightTheme, themeFg, themeEdgeColor, drawNodeBox,
} from './utils';
import {
    type Mat3,
    turntableMatrix,
} from './math3d';
import {
    type Mat4,
    mat4Perspective, mat4TurntableView, mat4Multiply, mat4Invert,
    mat4ProjectPoint, turntableCameraPos,
} from './gl_math';
import {
    GRID_VERT, GRID_FRAG, EDGE_VERT, EDGE_FRAG,
    createProgram,
} from './gl_shaders';

// Camera defaults
const CAM_DIST_MIN = 50;
const CAM_DIST_MAX = 20000;
const CAM_DIST_DEFAULT = 500;
const PITCH_MIN = -Math.PI / 2 + 0.05;
const PITCH_MAX = Math.PI / 2 - 0.05;
const YAW_SENSITIVITY = 0.005;
const PITCH_SENSITIVITY = 0.005;
const FOV_Y = Math.PI / 4; // 45 degrees
const NEAR = 1;
const FAR = 20000;

export class Graph3DRenderer implements IGraphRenderer {
    // WebGL
    private m_gl_canvas: HTMLCanvasElement | null = null;
    private m_gl: WebGLRenderingContext | null = null;

    // Canvas 2D overlay (for nodes, text, axes, gizmo)
    private m_overlay: HTMLCanvasElement | null = null;
    private m_ctx: CanvasRenderingContext2D | null = null;

    private m_callbacks: RendererCallbacks | null = null;

    // Shader programs
    private m_grid_prog: WebGLProgram | null = null;
    private m_edge_prog: WebGLProgram | null = null;

    // Buffers
    private m_grid_vbo: WebGLBuffer | null = null;
    private m_edge_vbo: WebGLBuffer | null = null;

    // Camera (turntable)
    private m_yaw = -2.356;
    private m_pitch = 0.5;
    private m_cam_distance = CAM_DIST_DEFAULT;

    // Orbit center (target)
    private m_target_x = 0;
    private m_target_y = 0;
    private m_target_z = 0;

    // Cached matrices (recomputed each frame)
    private m_vp: Mat4 = new Float32Array(16);
    private m_inv_vp: Mat4 = new Float32Array(16);
    private m_rot_matrix: Mat3 = turntableMatrix(-0.7, 0.5);

    // Interaction state
    private m_is_rotating = false;
    private m_is_panning = false;
    private m_is_dragging_node = false;
    private m_drag_node: LayoutNode | null = null;
    private m_drag_ndc_z = 0;
    private m_drag_start_mx = 0;
    private m_drag_start_my = 0;
    private m_drag_start_wx = 0;
    private m_drag_start_wy = 0;
    private m_drag_start_wz = 0;
    private m_last_mx = 0;
    private m_last_my = 0;
    private m_was_rotating = false;

    // Data references
    private m_nodes: LayoutNode[] = [];
    private m_state: GraphState | null = null;

    // Depth range for depth-cue fading
    private m_depth_min = 0;
    private m_depth_max = 0;

    // Event handlers
    private m_boundMouseMove = (e: MouseEvent) => this.handleMouseMove(e);
    private m_boundMouseUp = (e: MouseEvent) => this.handleMouseUp(e);
    private m_last_middle_click_time = 0;

    // ================================================================
    // IGraphRenderer: Lifecycle
    // ================================================================

    init(aCanvas: HTMLCanvasElement): void {
        this.m_gl_canvas = aCanvas;
        this.m_gl = aCanvas.getContext('webgl', {
            alpha: false,
            antialias: true,
            preserveDrawingBuffer: true,
            depth: true,
        })!;

        // Create overlay canvas as immediate next sibling of the WebGL canvas
        const parent = aCanvas.parentElement!;
        parent.style.position = 'relative'; // required for overlay absolute positioning
        this.m_overlay = document.createElement('canvas');
        this.m_overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1';
        this.m_overlay.dataset.overlay = '1';
        parent.insertBefore(this.m_overlay, aCanvas.nextSibling);
        this.m_ctx = this.m_overlay.getContext('2d')!;

        this.initGL();
    }

    private initGL(): void {
        const gl = this.m_gl!;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        // Required for dFdx/dFdy in grid shader (WebGL1)
        gl.getExtension('OES_standard_derivatives');

        // Compile shaders
        this.m_grid_prog = createProgram(gl, GRID_VERT, GRID_FRAG);
        this.m_edge_prog = createProgram(gl, EDGE_VERT, EDGE_FRAG);

        // Fullscreen quad for grid
        this.m_grid_vbo = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.m_grid_vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        // Edge buffer (dynamic)
        this.m_edge_vbo = gl.createBuffer()!;
    }

    dispose(): void {
        this.detachEvents();
        if (this.m_gl) {
            if (this.m_grid_prog) { this.m_gl.deleteProgram(this.m_grid_prog); }
            if (this.m_edge_prog) { this.m_gl.deleteProgram(this.m_edge_prog); }
            if (this.m_grid_vbo) { this.m_gl.deleteBuffer(this.m_grid_vbo); }
            if (this.m_edge_vbo) { this.m_gl.deleteBuffer(this.m_edge_vbo); }
        }
        if (this.m_overlay && this.m_overlay.parentElement) {
            this.m_overlay.parentElement.removeChild(this.m_overlay);
        }
        this.m_gl_canvas = null;
        this.m_gl = null;
        this.m_overlay = null;
        this.m_ctx = null;
    }

    // ================================================================
    // IGraphRenderer: Camera
    // ================================================================

    saveCamera(): CameraState {
        return {
            kind: '3d',
            camYaw: this.m_yaw, camPitch: this.m_pitch, camDistance: this.m_cam_distance,
            targetX: this.m_target_x, targetY: this.m_target_y, targetZ: this.m_target_z,
        };
    }

    restoreCamera(aState: CameraState): boolean {
        if (aState.kind !== '3d') { return false; }
        const s = aState as CameraState3D;
        this.m_yaw = s.camYaw;
        this.m_pitch = s.camPitch;
        this.m_cam_distance = s.camDistance;
        this.m_target_x = s.targetX ?? 0;
        this.m_target_y = s.targetY ?? 0;
        this.m_target_z = s.targetZ ?? 0;
        return true;
    }

    worldToScreen(aNode: LayoutNode): [number, number] {
        if (!this.m_gl_canvas) { return [0, 0]; }
        const w = this.m_gl_canvas.clientWidth, h = this.m_gl_canvas.clientHeight;
        const [sx, sy] = mat4ProjectPoint(this.m_vp, aNode.x, aNode.y, aNode.z, w, h);
        return [sx, sy];
    }

    centerOnNodes(aNodes: LayoutNode[], aIsFiltered: (n: GraphNode) => boolean): void {
        let cx = 0, cy = 0, cz = 0, count = 0;
        for (const ln of aNodes) {
            if (aIsFiltered(ln.node)) { continue; }
            cx += ln.x; cy += ln.y; cz += ln.z;
            count++;
        }
        if (count > 0) {
            this.m_target_x = cx / count;
            this.m_target_y = cy / count;
            this.m_target_z = cz / count;
        }
        let maxDist = 0;
        for (const ln of aNodes) {
            if (aIsFiltered(ln.node)) { continue; }
            const dx = ln.x - this.m_target_x, dy = ln.y - this.m_target_y, dz = ln.z - this.m_target_z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d > maxDist) { maxDist = d; }
        }
        this.m_cam_distance = Math.max(CAM_DIST_MIN, maxDist * 2.5);
        this.m_yaw = -2.356;
        this.m_pitch = 0.5;
    }

    // ================================================================
    // IGraphRenderer: Drag state
    // ================================================================

    isDraggingNode(): boolean { return this.m_is_dragging_node; }
    getDragNode(): LayoutNode | null { return this.m_drag_node; }

    // ================================================================
    // IGraphRenderer: Hit testing
    // ================================================================

    hitTestNode(aPosX: number, aPosY: number, aNodes: LayoutNode[], aIsFiltered: (n: GraphNode) => boolean): LayoutNode | null {
        if (!this.m_gl_canvas) { return null; }
        const w = this.m_gl_canvas.clientWidth, h = this.m_gl_canvas.clientHeight;
        const candidates: { ln: LayoutNode; sx: number; sy: number; ndcZ: number; scale: number }[] = [];
        for (const ln of aNodes) {
            if (aIsFiltered(ln.node)) { continue; }
            const [sx, sy, ndcZ] = mat4ProjectPoint(this.m_vp, ln.x, ln.y, ln.z, w, h);
            if (ndcZ < -1 || ndcZ > 1) { continue; } // behind camera or beyond far
            // Approximate perspective scale from focal length
            const depth = this.worldToDepth(ln.x, ln.y, ln.z);
            const focalLength = h / (2 * Math.tan(FOV_Y / 2));
            const scale = depth > 1 ? focalLength / depth : 1;
            candidates.push({ ln, sx, sy, ndcZ, scale });
        }
        candidates.sort((a, b) => a.ndcZ - b.ndcZ); // front-to-back

        for (const { ln, sx, sy, scale } of candidates) {
            const hw = (ln.w * scale) / 2;
            const hh = (NODE_H * scale) / 2;
            if (aPosX >= sx - hw && aPosX <= sx + hw && aPosY >= sy - hh && aPosY <= sy + hh) {
                return ln;
            }
        }
        return null;
    }

    /** Compute camera-space depth for a world point. */
    private worldToDepth(wx: number, wy: number, wz: number): number {
        const view = mat4TurntableView(this.m_yaw, this.m_pitch, this.m_cam_distance,
            this.m_target_x, this.m_target_y, this.m_target_z);
        // view * worldPoint → camera space, z component (column-major)
        return -(view[2] * wx + view[6] * wy + view[10] * wz + view[14]);
    }

    /** Perspective scale at a given camera-space depth. */
    private depthScale(depth: number): number {
        if (!this.m_gl_canvas) { return 1; }
        const h = this.m_gl_canvas.clientHeight;
        const focalLength = h / (2 * Math.tan(FOV_Y / 2));
        return depth > 1 ? focalLength / depth : 1;
    }

    // ================================================================
    // IGraphRenderer: Drawing
    // ================================================================

    draw(aNodes: LayoutNode[], aEdges: GraphEdge[], aState: GraphState): void {
        this.m_nodes = aNodes;
        this.m_state = aState;

        if (!this.m_gl_canvas || !this.m_gl || !this.m_ctx || !this.m_overlay) { return; }
        const gl = this.m_gl;
        const w = this.m_gl_canvas.clientWidth;
        const h = this.m_gl_canvas.clientHeight;
        if (w === 0 || h === 0) { return; }

        // Update matrices
        this.m_rot_matrix = turntableMatrix(this.m_yaw, this.m_pitch);
        const aspect = w / h;
        const proj = mat4Perspective(FOV_Y, aspect, NEAR, FAR);
        const view = mat4TurntableView(this.m_yaw, this.m_pitch, this.m_cam_distance,
            this.m_target_x, this.m_target_y, this.m_target_z);
        this.m_vp = mat4Multiply(proj, view);
        this.m_inv_vp = mat4Invert(this.m_vp);

        // Compute depth range for depth-cue
        this.computeDepthRange(aNodes, aState);

        // ---- WebGL pass ----
        const dpr = window.devicePixelRatio || 1;
        gl.viewport(0, 0, this.m_gl_canvas.width, this.m_gl_canvas.height);

        const bg = getCssVar('--vscode-editor-background') || (isLightTheme() ? '#ffffff' : '#1e1e1e');
        const bgR = parseInt(bg.slice(1, 3), 16) / 255;
        const bgG = parseInt(bg.slice(3, 5), 16) / 255;
        const bgB = parseInt(bg.slice(5, 7), 16) / 255;
        gl.clearColor(bgR, bgG, bgB, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        this.glDrawGrid(gl, w, h);
        this.glDrawEdges(gl, w, h, aNodes, aEdges, aState);

        // ---- Canvas 2D overlay pass ----
        const ctx = this.m_ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        this.drawNodes3D(ctx, w, h, aNodes, aState);
    }

    // ================================================================
    // Depth range helpers
    // ================================================================

    private computeDepthRange(nodes: LayoutNode[], s: GraphState): void {
        let dMin = Infinity, dMax = -Infinity;
        for (const ln of nodes) {
            if (s.isNodeFiltered(ln.node)) { continue; }
            const d = this.worldToDepth(ln.x, ln.y, ln.z);
            if (d < 1) { continue; }
            if (d < dMin) { dMin = d; }
            if (d > dMax) { dMax = d; }
        }
        this.m_depth_min = dMin === Infinity ? 0 : dMin;
        this.m_depth_max = dMax === -Infinity ? 0 : dMax;
    }

    private depthAlpha(depth: number): number {
        const range = this.m_depth_max - this.m_depth_min;
        if (range < 1) { return 1.0; }
        const t = (depth - this.m_depth_min) / range;
        return 1.0 - t * 0.65;
    }

    // ================================================================
    // WebGL: Grid
    // ================================================================

    private glDrawGrid(gl: WebGLRenderingContext, w: number, h: number): void {
        if (!this.m_grid_prog || !this.m_grid_vbo) { return; }
        gl.useProgram(this.m_grid_prog);

        // Adaptive grid spacing (1-2-5 sequence, ~60 CSS px cells)
        const focalLength = h / (2 * Math.tan(FOV_Y / 2));
        const scaleAtOrigin = focalLength / Math.max(this.m_cam_distance, 1);
        const rawStep = 60 / Math.max(scaleAtOrigin, 0.001);
        const log10 = Math.log10(rawStep);
        const pow = Math.pow(10, Math.floor(log10));
        const frac = rawStep / pow;
        let step: number;
        if (frac < 1.5) { step = pow; }
        else if (frac < 3.5) { step = pow * 2; }
        else if (frac < 7.5) { step = pow * 5; }
        else { step = pow * 10; }
        const majorStep = step * 5;

        // Camera position for distance fade
        const camPos = turntableCameraPos(this.m_yaw, this.m_pitch, this.m_cam_distance,
            this.m_target_x, this.m_target_y, this.m_target_z);

        // Grid line color
        const light = isLightTheme();
        const lineR = light ? 0 : 1, lineG = light ? 0 : 1, lineB = light ? 0 : 1;

        // Set uniforms
        const loc = (n: string) => gl.getUniformLocation(this.m_grid_prog!, n);
        gl.uniformMatrix4fv(loc('u_invVP'), false, this.m_inv_vp);
        gl.uniformMatrix4fv(loc('u_VP'), false, this.m_vp);
        gl.uniform3f(loc('u_cameraPos'), camPos[0], camPos[1], camPos[2]);
        gl.uniform2f(loc('u_resolution'), w, h);
        gl.uniform1f(loc('u_gridStep'), step);
        gl.uniform1f(loc('u_majorStep'), majorStep);
        gl.uniform1f(loc('u_camDistance'), this.m_cam_distance);
        gl.uniform4f(loc('u_lineColor'), lineR, lineG, lineB, 0.6);

        // Disable depth write for grid (it's the floor, render behind everything)
        gl.depthMask(false);

        // Draw fullscreen quad
        gl.bindBuffer(gl.ARRAY_BUFFER, this.m_grid_vbo);
        const aPos = gl.getAttribLocation(this.m_grid_prog, 'a_position');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disableVertexAttribArray(aPos);

        gl.depthMask(true);
    }

    // ================================================================
    // WebGL: Edges
    // ================================================================

    private glDrawEdges(gl: WebGLRenderingContext, w: number, h: number, nodes: LayoutNode[], edges: GraphEdge[], s: GraphState): void {
        if (!this.m_edge_prog || !this.m_edge_vbo || edges.length === 0) { return; }

        const nm = new Map<string, LayoutNode>();
        for (const ln of nodes) { if (!s.isNodeFiltered(ln.node)) { nm.set(ln.node.id, ln); } }

        // Build edge vertex data: 6 vertices per edge (2 triangles = 1 quad)
        // Attributes per vertex: from(3) + to(3) + corner(2) + color(4) + widthFrom(1) + widthTo(1) = 14 floats
        const FLOATS_PER_VERT = 14;
        const data: number[] = [];

        const light = isLightTheme();
        const edgeR = light ? 0 : 1, edgeG = light ? 0 : 1, edgeB = light ? 0 : 1;

        for (const e of edges) {
            const f = nm.get(e.from), t = nm.get(e.to);
            if (!f || !t) { continue; }

            const isHighlighted = s.selectedNodeId && (e.from === s.selectedNodeId || e.to === s.selectedNodeId);
            if (isHighlighted) { continue; } // draw highlighted edges in second pass

            const dimmed = s.isNodeDimmed(f.node) && s.isNodeDimmed(t.node);
            const avgDepth = (this.worldToDepth(f.x, f.y, f.z) + this.worldToDepth(t.x, t.y, t.z)) / 2;
            const alpha = dimmed ? 0.04 : 0.15 * this.depthAlpha(avgDepth);

            const wFrom = s.edgeStyle === EdgeStyle.TAPERED ? Math.max(1.5, 3 * s.simVars.taperedWidth) : 1.5;
            const wTo = s.edgeStyle === EdgeStyle.TAPERED ? Math.max(0.3, 0.5 * s.simVars.taperedWidth) : 1.5;

            let sx = f.x, sy = f.y, sz = f.z, ex = t.x, ey = t.y, ez = t.z;
            if (s.edgeDirection === EdgeDirection.USED_BY) {
                sx = t.x; sy = t.y; sz = t.z; ex = f.x; ey = f.y; ez = f.z;
            }

            this.pushEdgeQuad(data, sx, sy, sz, ex, ey, ez, edgeR, edgeG, edgeB, alpha, wFrom, wTo);
        }

        // Highlighted edges (second pass)
        if (s.selectedNodeId) {
            for (const e of edges) {
                if (e.from !== s.selectedNodeId && e.to !== s.selectedNodeId) { continue; }
                const f = nm.get(e.from), t = nm.get(e.to);
                if (!f || !t) { continue; }

                // Use the selected node's color
                const base = e.from === s.selectedNodeId ? f : t;
                const hex = base.node.color;
                const r = parseInt(hex.slice(1, 3), 16) / 255;
                const g = parseInt(hex.slice(3, 5), 16) / 255;
                const b = parseInt(hex.slice(5, 7), 16) / 255;

                let sx = f.x, sy = f.y, sz = f.z, ex = t.x, ey = t.y, ez = t.z;
                if (s.edgeDirection === EdgeDirection.USED_BY) {
                    sx = t.x; sy = t.y; sz = t.z; ex = f.x; ey = f.y; ez = f.z;
                }

                const wFrom = s.edgeStyle === EdgeStyle.TAPERED ? Math.max(2, 4 * s.simVars.taperedWidth) : 2;
                const wTo = s.edgeStyle === EdgeStyle.TAPERED ? Math.max(0.5, 1 * s.simVars.taperedWidth) : 2;

                this.pushEdgeQuad(data, sx, sy, sz, ex, ey, ez, r, g, b, 0.8, wFrom, wTo);
            }
        }

        if (data.length === 0) { return; }

        const floatData = new Float32Array(data);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.m_edge_vbo);
        gl.bufferData(gl.ARRAY_BUFFER, floatData, gl.DYNAMIC_DRAW);

        gl.useProgram(this.m_edge_prog);

        const loc = (n: string) => gl.getUniformLocation(this.m_edge_prog!, n);
        gl.uniformMatrix4fv(loc('u_VP'), false, this.m_vp);
        gl.uniform2f(loc('u_resolution'), w, h);

        // Disable depth test for edges (they overlay the grid)
        gl.disable(gl.DEPTH_TEST);

        const stride = FLOATS_PER_VERT * 4;
        const aFrom = gl.getAttribLocation(this.m_edge_prog, 'a_from');
        const aTo = gl.getAttribLocation(this.m_edge_prog, 'a_to');
        const aCorner = gl.getAttribLocation(this.m_edge_prog, 'a_corner');
        const aColor = gl.getAttribLocation(this.m_edge_prog, 'a_color');
        const aWF = gl.getAttribLocation(this.m_edge_prog, 'a_widthFrom');
        const aWT = gl.getAttribLocation(this.m_edge_prog, 'a_widthTo');

        gl.enableVertexAttribArray(aFrom);
        gl.enableVertexAttribArray(aTo);
        gl.enableVertexAttribArray(aCorner);
        gl.enableVertexAttribArray(aColor);
        gl.enableVertexAttribArray(aWF);
        gl.enableVertexAttribArray(aWT);

        gl.vertexAttribPointer(aFrom, 3, gl.FLOAT, false, stride, 0);
        gl.vertexAttribPointer(aTo, 3, gl.FLOAT, false, stride, 12);
        gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, stride, 24);
        gl.vertexAttribPointer(aColor, 4, gl.FLOAT, false, stride, 32);
        gl.vertexAttribPointer(aWF, 1, gl.FLOAT, false, stride, 48);
        gl.vertexAttribPointer(aWT, 1, gl.FLOAT, false, stride, 52);

        const vertexCount = data.length / FLOATS_PER_VERT;
        gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

        gl.disableVertexAttribArray(aFrom);
        gl.disableVertexAttribArray(aTo);
        gl.disableVertexAttribArray(aCorner);
        gl.disableVertexAttribArray(aColor);
        gl.disableVertexAttribArray(aWF);
        gl.disableVertexAttribArray(aWT);

        gl.enable(gl.DEPTH_TEST);
    }

    /** Push 6 vertices (2 triangles) for one edge quad. */
    private pushEdgeQuad(
        data: number[],
        fx: number, fy: number, fz: number,
        tx: number, ty: number, tz: number,
        r: number, g: number, b: number, a: number,
        wFrom: number, wTo: number,
    ): void {
        // corners: (t along edge, side perpendicular)
        // Triangle 1: (0,-1), (1,-1), (0,+1)
        // Triangle 2: (1,-1), (1,+1), (0,+1)
        const corners = [
            [0, -1], [1, -1], [0, 1],
            [1, -1], [1, 1], [0, 1],
        ];
        for (const [ct, cs] of corners) {
            data.push(fx, fy, fz, tx, ty, tz, ct, cs, r, g, b, a, wFrom, wTo);
        }
    }

    // ================================================================
    // Canvas 2D overlay: Nodes
    // ================================================================

    private drawNodes3D(ctx: CanvasRenderingContext2D, w: number, h: number, nodes: LayoutNode[], s: GraphState): void {
        const projected: { ln: LayoutNode; sx: number; sy: number; depth: number; scale: number }[] = [];
        for (const ln of nodes) {
            if (s.isNodeFiltered(ln.node)) { continue; }
            const [sx, sy, ndcZ] = mat4ProjectPoint(this.m_vp, ln.x, ln.y, ln.z, w, h);
            if (ndcZ < -1 || ndcZ > 1) { continue; }
            const depth = this.worldToDepth(ln.x, ln.y, ln.z);
            const scale = this.depthScale(depth);
            const sw = ln.w * scale, sh = NODE_H * scale;
            if ((sx + sw / 2) < 0 || (sx - sw / 2) > w || (sy + sh / 2) < 0 || (sy - sh / 2) > h) { continue; }
            projected.push({ ln, sx, sy, depth, scale });
        }
        if (projected.length === 0) { return; }

        projected.sort((a, b) => b.depth - a.depth); // back-to-front

        for (const { ln, sx, sy, depth, scale } of projected) {
            const sw = ln.w * scale;
            const sh = NODE_H * scale;
            const isImportant = ln.node.id === s.selectedNodeId || (s.focusedNodeId !== null && ln.node.id === s.focusedNodeId);
            const da = isImportant ? 1.0 : this.depthAlpha(depth);
            const baseAlpha = s.isNodeDimmed(ln.node) ? 0.12 : da;

            drawNodeBox(ctx, sx, sy, sw, sh, scale, ln.node,
                baseAlpha,
                ln.node.id === s.selectedNodeId, ln.pinned,
                s.focusedNodeId !== null && ln.node.id === s.focusedNodeId);
        }
    }

    // ================================================================
    // IGraphRenderer: Events
    // ================================================================

    attachEvents(aCanvas: HTMLCanvasElement, aCallbacks: RendererCallbacks): void {
        this.m_callbacks = aCallbacks;
        aCanvas.addEventListener('keydown', this.handleKeyDown);
        aCanvas.addEventListener('keyup', this.handleKeyUp);
        aCanvas.addEventListener('mousedown', this.handleMouseDown);
        aCanvas.addEventListener('auxclick', this.handleAuxClick);
        aCanvas.addEventListener('dblclick', this.handleDblClick);
        aCanvas.addEventListener('wheel', this.handleWheel, { passive: false });
        window.addEventListener('mousemove', this.m_boundMouseMove);
        window.addEventListener('mouseup', this.m_boundMouseUp);
        aCanvas.style.cursor = 'grab';
    }

    detachEvents(): void {
        if (this.m_gl_canvas) {
            this.m_gl_canvas.removeEventListener('keydown', this.handleKeyDown);
            this.m_gl_canvas.removeEventListener('keyup', this.handleKeyUp);
            this.m_gl_canvas.removeEventListener('mousedown', this.handleMouseDown);
            this.m_gl_canvas.removeEventListener('auxclick', this.handleAuxClick);
            this.m_gl_canvas.removeEventListener('dblclick', this.handleDblClick);
            this.m_gl_canvas.removeEventListener('wheel', this.handleWheel);
        }
        window.removeEventListener('mousemove', this.m_boundMouseMove);
        window.removeEventListener('mouseup', this.m_boundMouseUp);
        this.m_callbacks = null;
    }

    // ================================================================
    // Private: Event handlers (mostly unchanged from Canvas 2D version)
    // ================================================================

    private handleAuxClick = (e: MouseEvent): void => {
        if (e.button === 1) { e.preventDefault(); }
    };

    private handleKeyDown = (e: KeyboardEvent): void => {
        if (e.key === ' ') { e.preventDefault(); }
    };

    private handleKeyUp = (e: KeyboardEvent): void => {
        if (e.key === ' ') { e.preventDefault(); this.m_callbacks?.onStartStopSimulation(); }
    };

    private handleMouseDown = (e: MouseEvent): void => {
        if (!this.m_gl_canvas || !this.m_state || !this.m_callbacks) { return; }
        const w = this.m_gl_canvas.clientWidth, h = this.m_gl_canvas.clientHeight;

        // Middle-click: hit node → center orbit; double-middle → reset; else pan
        if (e.button === 1) {
            e.preventDefault();
            const rect = this.m_gl_canvas.getBoundingClientRect();
            const mmx = e.clientX - rect.left, mmy = e.clientY - rect.top;

            const now = Date.now();
            if (now - this.m_last_middle_click_time < 400) {
                let sx = 0, sy = 0, sz = 0, count = 0;
                for (const ln of this.m_nodes) {
                    if (this.m_state!.isNodeFiltered(ln.node)) { continue; }
                    sx += ln.x; sy += ln.y; sz += ln.z; count++;
                }
                if (count > 0) {
                    this.m_target_x = sx / count;
                    this.m_target_y = sy / count;
                    this.m_target_z = sz / count;
                }
                this.m_last_middle_click_time = 0;
                this.m_callbacks.onCameraChanged();
                this.m_callbacks.onRequestDraw();
                return;
            }
            this.m_last_middle_click_time = now;

            const midHit = this.hitTestNode(mmx, mmy, this.m_nodes, this.m_state.isNodeFiltered);
            if (midHit) {
                this.m_target_x = midHit.x;
                this.m_target_y = midHit.y;
                this.m_target_z = midHit.z;
                this.m_callbacks.onCameraChanged();
                this.m_callbacks.onRequestDraw();
                return;
            }

            this.m_is_panning = true;
            this.m_last_mx = mmx;
            this.m_last_my = mmy;
            this.m_gl_canvas.style.cursor = 'all-scroll';
            return;
        }

        if (e.button !== 0) { return; }
        e.preventDefault();
        this.m_gl_canvas.focus();
        const rect = this.m_gl_canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;

        const hit = this.hitTestNode(mx, my, this.m_nodes, this.m_state.isNodeFiltered);
        if (hit) {
            this.m_is_dragging_node = true;
            this.m_drag_node = hit;
            const [sx, sy, ndcZ] = mat4ProjectPoint(this.m_vp, hit.x, hit.y, hit.z, w, h);
            this.m_drag_ndc_z = ndcZ;
            this.m_drag_start_mx = mx;
            this.m_drag_start_my = my;
            this.m_drag_start_wx = hit.x;
            this.m_drag_start_wy = hit.y;
            this.m_drag_start_wz = hit.z;
            this.m_gl_canvas.style.cursor = 'move';
            this.m_callbacks.onNodeClick(hit);
            this.m_callbacks.onNodeDragStart(hit);
        } else {
            this.m_is_rotating = true;
            this.m_was_rotating = false;
            this.m_last_mx = mx;
            this.m_last_my = my;
            this.m_gl_canvas.style.cursor = 'grabbing';
        }
        this.m_callbacks.onRequestDraw();
    };

    private handleMouseMove(e: MouseEvent): void {
        window.focus();
        if (!this.m_gl_canvas) { return; }
        const rect = this.m_gl_canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const w = this.m_gl_canvas.clientWidth, h = this.m_gl_canvas.clientHeight;

        if (this.m_is_dragging_node && this.m_drag_node) {
            // Screen-space delta
            const dx = mx - this.m_drag_start_mx;
            const dy = my - this.m_drag_start_my;
            // Convert pixels to world units at the node's camera-space depth
            const depth = this.worldToDepth(this.m_drag_start_wx, this.m_drag_start_wy, this.m_drag_start_wz);
            const focalLength = h / (2 * Math.tan(FOV_Y / 2));
            const p2w = depth / focalLength;
            // Camera right and up from the view matrix (row 0 and row 1 in column-major)
            const view = mat4TurntableView(this.m_yaw, this.m_pitch, this.m_cam_distance,
                this.m_target_x, this.m_target_y, this.m_target_z);
            const rX = view[0], rY = view[4], rZ = view[8];   // camera right in world
            const uX = view[1], uY = view[5], uZ = view[9];   // camera up in world
            this.m_drag_node.x = this.m_drag_start_wx + dx * p2w * rX - dy * p2w * uX;
            this.m_drag_node.y = this.m_drag_start_wy + dx * p2w * rY - dy * p2w * uY;
            this.m_drag_node.z = this.m_drag_start_wz + dx * p2w * rZ - dy * p2w * uZ;
            this.m_callbacks?.onRequestDraw();
        } else if (this.m_is_panning) {
            const deltaX = mx - this.m_last_mx;
            const deltaY = my - this.m_last_my;
            const pixToWorld = this.m_cam_distance / (h / (2 * Math.tan(FOV_Y / 2)));
            // Camera right for horizontal pan (row0 = [cy, 0, sy], pure XZ)
            const rx = this.m_rot_matrix[0], rz = this.m_rot_matrix[2];
            // Horizontal drag → move in camera-right (XZ plane only)
            // Vertical drag → move in world Y (no diagonal)
            this.m_target_x += -deltaX * rx * pixToWorld;
            this.m_target_y += deltaY * pixToWorld;
            this.m_target_z += -deltaX * rz * pixToWorld;
            this.m_last_mx = mx;
            this.m_last_my = my;
            this.m_callbacks?.onRequestDraw();
        } else if (this.m_is_rotating) {
            const deltaX = mx - this.m_last_mx;
            const deltaY = my - this.m_last_my;
            if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
                this.m_was_rotating = true;
            }
            this.m_yaw += deltaX * YAW_SENSITIVITY;
            this.m_pitch += deltaY * PITCH_SENSITIVITY;
            this.m_pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.m_pitch));
            this.m_last_mx = mx;
            this.m_last_my = my;
            this.m_callbacks?.onRequestDraw();
        }
    }

    private handleMouseUp(e: MouseEvent): void {
        if (!this.m_gl_canvas) { return; }
        if (e.button === 1 && this.m_is_panning) {
            this.m_is_panning = false;
            this.m_gl_canvas.style.cursor = 'grab';
            this.m_callbacks?.onCameraChanged();
            return;
        }
        if (e.button !== 0) { return; }
        if (this.m_is_dragging_node) {
            this.m_is_dragging_node = false;
            this.m_drag_node = null;
            this.m_gl_canvas.style.cursor = 'grab';
            this.m_callbacks?.onNodeDragEnd();
        } else if (this.m_is_rotating) {
            if (!this.m_was_rotating && e.target === this.m_gl_canvas) {
                this.m_callbacks?.onBackgroundClick();
            }
            this.m_is_rotating = false;
            this.m_gl_canvas.style.cursor = 'grab';
            this.m_callbacks?.onCameraChanged();
        }
    }

    private handleDblClick = (e: MouseEvent): void => {
        if (!this.m_gl_canvas || !this.m_callbacks || !this.m_state) { return; }
        window.focus();
        if (this.m_state.selectedNodeId) {
            this.m_callbacks.onDoubleClickNode(this.m_state.selectedNodeId, e.ctrlKey || e.metaKey);
        } else {
            this.m_callbacks.onDoubleClickBackground();
        }
    };

    private handleWheel = (e: WheelEvent): void => {
        if (!this.m_gl_canvas) { return; }
        e.preventDefault();
        window.focus();
        const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
        this.m_cam_distance = Math.max(CAM_DIST_MIN, Math.min(CAM_DIST_MAX, this.m_cam_distance * factor));
        this.m_callbacks?.onCameraChanged();
        this.m_callbacks?.onRequestDraw();
    };
}
