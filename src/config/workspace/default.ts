import { WorkspaceConfig as WorkspaceTypes } from './types';

// Default values for workspace (per-project) settings
// Aligned with package.json "contributes.configuration.properties"
export const WorkspaceConfigDefault: WorkspaceTypes.Settings = {
    general: {
        buildDirectory: '${workspaceFolder}/build',
        configType: 'Release',
    },
    graph: {
        colors: {
            EXECUTABLE: '#7f5be3',
            STATIC_LIBRARY: '#2196F3',
            SHARED_LIBRARY: '#52ff67',
            MODULE_LIBRARY: '#9C27B0',
            OBJECT_LIBRARY: '#cf6eff',
            INTERFACE_LIBRARY: '#00BCD4',
            SYSTEM_LIBRARY: '#c8ea32',
            UTILITY: '#c63f0e',
        },
        edges: {
            edgeDirection: WorkspaceTypes.Graph.EdgeDirection.USED_BY,
            edgeStyle: WorkspaceTypes.Graph.EdgeStyle.TAPERED,
            taperedWidth: 2,
        },
        simulation: {
            params: {
                repulsion: 50000,
                attraction: 0.05,
                gravity: 0.01,
                linkLength: 0.05,
                minDistance: 1000,
                stepsPerFrame: 5,
                threshold: 0.5,
                damping: 0.85,
            },
            controls: {
                minimap: true,
                autoPauseDrag: false,
                simEnabled: true,
                settingsCollapse: { controls: false, display: false, edges: false, simulation: true, colors: true },
                settingsVisible: false,
                mode3d: false,
            },
        },
    },
};
