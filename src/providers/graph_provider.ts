import * as vscode from 'vscode';
import { Target, TargetType } from '../cmake/types';
import { wksConfigManager } from '../config/workspace/manager';
import { WorkspaceConfigDefault } from '../config/workspace/default';

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

const TARGET_SHAPES: Record<TargetType, string> = {
    EXECUTABLE: 'box',
    STATIC_LIBRARY: 'box',
    SHARED_LIBRARY: 'box',
    MODULE_LIBRARY: 'box',
    OBJECT_LIBRARY: 'box',
    INTERFACE_LIBRARY: 'box',
    SYSTEM_LIBRARY: 'box',
    UTILITY: 'box',
};

/** CMake-generated utility targets that clutter the graph */
const EXCLUDED_TARGETS = new Set([
    'ALL_BUILD', 'ZERO_CHECK', 'RUN_TESTS', 'INSTALL', 'PACKAGE',
]);

// ------------------------------------------------------------
// Graph data sent to webview
// ------------------------------------------------------------
interface GraphNode {
    id: string;
    label: string;
    type: TargetType;
    color: string;
    shape: string;
    sourcePath: string;
}

interface GraphEdge {
    from: string;
    to: string;
}

// ------------------------------------------------------------
// DependencyGraphProvider
// ------------------------------------------------------------
export class DependencyGraphProvider {
    private m_targets: Target[] = [];
    private m_panels: Set<vscode.WebviewPanel> = new Set();
    private m_activePanel?: vscode.WebviewPanel;

    constructor(private readonly m_extensionUri: vscode.Uri) { }

    // ---- Public API ----

    refresh(aTargets: Target[]): void {
        this.m_targets = aTargets;
    }

    openInEditor(aFocusTargetId?: string): void {
        const title = aFocusTargetId
            ? `Graph: ${this.m_targets.find(t => t.id === aFocusTargetId)?.name ?? 'Target'}`
            : 'Dependency Graph';

        const panel = vscode.window.createWebviewPanel(
            'CMakeGraph.dependencyGraphEditor',
            title,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.m_extensionUri, 'out'),
                    vscode.Uri.joinPath(this.m_extensionUri, 'dist'),
                    vscode.Uri.joinPath(this.m_extensionUri, 'medias'),
                ],
            },
        );

        this.m_panels.add(panel);
        this.m_activePanel = panel;

        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(aMsg => {
            if (aMsg.type === 'ready') {
                panel.webview.postMessage(this.buildGraphDataMessage());
                if (aFocusTargetId) {
                    panel.webview.postMessage({ type: 'focusNode', targetId: aFocusTargetId });
                }
            } else {
                this.handleMessage(aMsg);
            }
        });

        panel.onDidChangeViewState(() => {
            if (panel.active) {
                this.m_activePanel = panel;
            }
        });

        panel.onDidDispose(() => {
            this.m_panels.delete(panel);
            if (this.m_activePanel === panel) {
                this.m_activePanel = undefined;
            }
        });
    }

    refreshActivePanel(): void {
        this.m_activePanel?.webview.postMessage(this.buildGraphDataMessage());
    }

    showSettings(): void {
        this.m_activePanel?.webview.postMessage({ type: 'showSettings' });
    }

    screenshot(): void {
        this.m_activePanel?.webview.postMessage({ type: 'screenshot' });
    }

    exportCsv(): void {
        this.m_activePanel?.webview.postMessage({ type: 'exportCsv' });
    }

    // ---- Data conversion ----

    private buildGraphDataMessage(): object {
        const s = wksConfigManager.settings;
        const colors = s.graph.colors;

        const filtered = this.m_targets.filter(t => t.type !== 'UTILITY');
        const valid_ids = new Set(filtered.map(t => t.id));

        const nodes: GraphNode[] = filtered.map(t => ({
            id: t.id,
            label: t.name,
            type: t.type,
            color: colors[t.type] ?? '#888888',
            shape: TARGET_SHAPES[t.type],
            sourcePath: t.paths.source,
        }));

        const edges: GraphEdge[] = filtered.flatMap(t =>
            (t.directLinks ?? [])
                .filter(id => valid_ids.has(id))
                .map(id => ({ from: t.id, to: id })),
        );

        const settings = {
            edgeDirection: s.graph.edges.edgeDirection,
            edgeStyle: s.graph.edges.edgeStyle,
            taperedWidth: s.graph.edges.taperedWidth,
            simRepulsion: s.graph.simulation.params.repulsion,
            simAttraction: s.graph.simulation.params.attraction,
            simGravity: s.graph.simulation.params.gravity,
            simLinkLength: s.graph.simulation.params.linkLength,
            simMinDistance: s.graph.simulation.params.minDistance,
            simStepsPerFrame: s.graph.simulation.params.stepsPerFrame,
            simThreshold: s.graph.simulation.params.threshold,
            simDamping: s.graph.simulation.params.damping,
            minimap: s.graph.simulation.controls.minimap,
            autoPauseDrag: s.graph.simulation.controls.autoPauseDrag,
            simEnabled: s.graph.simulation.controls.simEnabled,
            settingsCollapse: s.graph.simulation.controls.settingsCollapse,
            settingsVisible: s.graph.simulation.controls.settingsVisible,
        };

        const d = WorkspaceConfigDefault.graph;
        const defaults = {
            edgeDirection: d.edges.edgeDirection,
            edgeStyle: d.edges.edgeStyle,
            taperedWidth: d.edges.taperedWidth,
            simRepulsion: d.simulation.params.repulsion,
            simAttraction: d.simulation.params.attraction,
            simGravity: d.simulation.params.gravity,
            simLinkLength: d.simulation.params.linkLength,
            simMinDistance: d.simulation.params.minDistance,
            simStepsPerFrame: d.simulation.params.stepsPerFrame,
            simThreshold: d.simulation.params.threshold,
            simDamping: d.simulation.params.damping,
            minimap: d.simulation.controls.minimap,
            autoPauseDrag: d.simulation.controls.autoPauseDrag,
            simEnabled: d.simulation.controls.simEnabled,
            nodeColors: d.colors,
        };

        return { type: 'update', nodes, edges, settings, defaults };
    }

    // ---- Message handling ----

    private handleMessage(aMsg: any): void {
        switch (aMsg.type) {
            case 'nodeClick': {
                // Reveal in Project Outline (reuse existing revealDependency command)
                vscode.commands.executeCommand('CMakeGraph.revealDependency', {
                    kind: 'dependency',
                    target: { id: aMsg.targetId as string },
                });
                break;
            }

            case 'saveScreenshot': {
                this.saveScreenshot(aMsg.dataUri as string);
                break;
            }

            case 'updateSetting': {
                wksConfigManager.updateSetting(aMsg.key as string, aMsg.value);
                break;
            }

            case 'csvData': {
                this.saveCsv(aMsg.rows as { node_a: string; type_a: string; link_type: string; node_b: string; type_b: string }[]);
                break;
            }
        }
    }

    private async saveCsv(aRows: { node_a: string; type_a: string; link_type: string; node_b: string; type_b: string }[]): Promise<void> {
        const lines = ['node_a,type_a,link_type,node_b,type_b'];
        for (const r of aRows) {
            lines.push(`${r.node_a},${r.type_a},${r.link_type},${r.node_b},${r.type_b}`);
        }
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${vscode.workspace.name ?? 'project'}_graph.csv`),
            filters: { 'CSV': ['csv'] },
        });
        if (!uri) { return; }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(lines.join('\n'), 'utf-8'));
        vscode.window.showInformationMessage(`CSV exported to ${uri.fsPath}`);
    }

    private async saveScreenshot(aDataUri: string): Promise<void> {
        const workspace_name = vscode.workspace.name ?? 'project';
        const now = new Date();
        const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        const default_name = `${workspace_name}_graph_${timestamp}.png`;
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(default_name),
            filters: { 'PNG Image': ['png'] },
        });
        if (!uri) { return; }
        const base64 = aDataUri.replace(/^data:image\/png;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        await vscode.workspace.fs.writeFile(uri, buffer);
        vscode.window.showInformationMessage(`Screenshot saved to ${uri.fsPath}`);
    }

    // ---- HTML ----

    private getHtml(aWebview: vscode.Webview): string {
        const nonce = getNonce();
        const script_uri = aWebview.asWebviewUri(
            vscode.Uri.joinPath(this.m_extensionUri, 'out', 'webview', 'graph_webview.js'),
        );
        const style_uri = aWebview.asWebviewUri(
            vscode.Uri.joinPath(this.m_extensionUri, 'medias', 'css', 'graph.css'),
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${aWebview.cspSource} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   img-src ${aWebview.cspSource} blob: data:;
                   connect-src ${aWebview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${style_uri}">
    <title>Dependency Graph</title>
</head>
<body>
    <div id="toolbar">
        <div id="filters"></div>
    </div>
    <div id="breadcrumb-bar"></div>
    <div id="graph-container" style="display:none"></div>
    <div id="empty-message">Waiting for CMake data\u2026</div>
    <div id="footer"></div>
    <script nonce="${nonce}" src="${script_uri}"></script>
</body>
</html>`;
    }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
