// ------------------------------------------------------------
// 2D Force-directed simulation engine.
// Extracted from the original monolithic graph_webview.ts.
// ------------------------------------------------------------

import type { GraphEdge, GraphNode, ISimulation, LayoutNode, SimVars } from './types';

export class Simulation2D implements ISimulation {
    private m_nodesCount = 0;
    private m_forcesX = new Float64Array(0);
    private m_forcesY = new Float64Array(0);
    private readonly m_nodeIndex = new Map<string, number>();
    private readonly m_adjacency = new Map<string, Set<string>>();
    private readonly m_degree = new Map<string, number>();

    step(
        aNodes: LayoutNode[],
        aEdges: GraphEdge[],
        aVars: SimVars,
        aIsFiltered: (n: GraphNode) => boolean,
        aDragNode: LayoutNode | null,
        aIsPinned: (n: LayoutNode) => boolean,
    ): number {
        this.computeAdjacency(aNodes, aEdges);
        this.repulseNodes(aNodes, aVars, aIsFiltered);
        this.attractLinks(aNodes, aEdges, aVars, aIsFiltered);
        this.dynamicBarycenter(aNodes, aVars);
        return this.applyForces(aNodes, aVars, aIsFiltered, aDragNode, aIsPinned);
    }

    private computeAdjacency(aNodes: LayoutNode[], aEdges: GraphEdge[]): void {
        this.m_nodeIndex.clear();
        aNodes.forEach((ln, i) => this.m_nodeIndex.set(ln.node.id, i));

        this.m_nodesCount = aNodes.length;
        this.m_forcesX = new Float64Array(this.m_nodesCount);
        this.m_forcesY = new Float64Array(this.m_nodesCount);

        this.m_adjacency.clear();
        this.m_degree.clear();

        for (const edge of aEdges) {
            if (!this.m_adjacency.has(edge.from)) { this.m_adjacency.set(edge.from, new Set()); }
            if (!this.m_adjacency.has(edge.to)) { this.m_adjacency.set(edge.to, new Set()); }
            this.m_adjacency.get(edge.from)!.add(edge.to);
            this.m_adjacency.get(edge.to)!.add(edge.from);
        }

        for (let i = 0; i < this.m_nodesCount; i++) {
            const id = aNodes[i].node.id;
            const deg = this.m_adjacency.get(id)?.size ?? 0;
            this.m_degree.set(id, deg);
            aNodes[i].mass = 1 + deg * 0.5;
        }
    }

    private repulseNodes(aNodes: LayoutNode[], aVars: SimVars, aIsFiltered: (n: GraphNode) => boolean): void {
        for (let i = 0; i < this.m_nodesCount; i++) {
            if (aIsFiltered(aNodes[i].node)) { continue; }
            const id_i = aNodes[i].node.id;
            const deg_i = this.m_degree.get(id_i) ?? 0;
            const adj_i = this.m_adjacency.get(id_i);

            for (let j = i + 1; j < this.m_nodesCount; j++) {
                if (aIsFiltered(aNodes[j].node)) { continue; }
                const id_j = aNodes[j].node.id;
                const connected = adj_i !== undefined && adj_i.has(id_j);

                let dx = aNodes[j].x - aNodes[i].x;
                let dy = aNodes[j].y - aNodes[i].y;
                let dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < 0.1) {
                    dx = (Math.random() - 0.5) * 2;
                    dy = (Math.random() - 0.5) * 2;
                    dist = 1;
                }

                let force = aVars.repulsion / (dist * dist);
                if (dist < aVars.minDistance) {
                    force *= (aVars.minDistance / dist);
                }
                if (!connected) {
                    const deg_j = this.m_degree.get(id_j) ?? 0;
                    const deg_boost = 1 + 0.15 * (deg_i + deg_j);
                    force *= deg_boost;
                }

                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                this.m_forcesX[i] -= fx;
                this.m_forcesY[i] -= fy;
                this.m_forcesX[j] += fx;
                this.m_forcesY[j] += fy;
            }
        }
    }

    private attractLinks(aNodes: LayoutNode[], aEdges: GraphEdge[], aVars: SimVars, aIsFiltered: (n: GraphNode) => boolean): void {
        for (const edge of aEdges) {
            const fi = this.m_nodeIndex.get(edge.from);
            const ti = this.m_nodeIndex.get(edge.to);
            if (fi === undefined || ti === undefined) { continue; }
            if (aIsFiltered(aNodes[fi].node)) { continue; }
            if (aIsFiltered(aNodes[ti].node)) { continue; }

            const dx = aNodes[ti].x - aNodes[fi].x;
            const dy = aNodes[ti].y - aNodes[fi].y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1) { continue; }

            const force = aVars.attraction * Math.log(2 + dist) / aVars.linkLength;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            this.m_forcesX[fi] += fx;
            this.m_forcesY[fi] += fy;
            this.m_forcesX[ti] -= fx;
            this.m_forcesY[ti] -= fy;
        }
    }

    private dynamicBarycenter(aNodes: LayoutNode[], aVars: SimVars): void {
        let totalMass = 0;
        let centerX = 0;
        let centerY = 0;

        for (let i = 0; i < this.m_nodesCount; i++) {
            const ln = aNodes[i];
            const m = ln.mass || 1;
            centerX += ln.x * m;
            centerY += ln.y * m;
            totalMass += m;
        }
        centerX /= totalMass;
        centerY /= totalMass;

        for (let i = 0; i < this.m_nodesCount; i++) {
            const ln = aNodes[i];
            this.m_forcesX[i] -= ln.x * aVars.gravity * 0.1;
            this.m_forcesY[i] -= ln.y * aVars.gravity * 0.1;
        }
    }

    private applyForces(
        aNodes: LayoutNode[],
        aVars: SimVars,
        aIsFiltered: (n: GraphNode) => boolean,
        aDragNode: LayoutNode | null,
        aIsPinned: (n: LayoutNode) => boolean,
    ): number {
        const max_speed = 20;
        let totalEnergy = 0;

        for (let i = 0; i < this.m_nodesCount; i++) {
            if (aIsFiltered(aNodes[i].node)) { continue; }
            if (aDragNode === aNodes[i]) { continue; }
            if (aIsPinned(aNodes[i])) { continue; }

            const ln = aNodes[i];
            const m = ln.mass || 1;

            const ax = this.m_forcesX[i] / m;
            const ay = this.m_forcesY[i] / m;

            ln.vx = (ln.vx + ax) * aVars.damping;
            ln.vy = (ln.vy + ay) * aVars.damping;

            const speed = Math.sqrt(ln.vx * ln.vx + ln.vy * ln.vy);
            if (speed > max_speed) {
                const ratio = max_speed / speed;
                ln.vx *= ratio;
                ln.vy *= ratio;
            }

            ln.x += ln.vx;
            ln.y += ln.vy;
            totalEnergy += Math.abs(ln.vx) + Math.abs(ln.vy);
        }

        return totalEnergy;
    }
}
