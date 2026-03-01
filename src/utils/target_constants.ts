import { TargetType } from '../cmake/types';

/** Codicon icon id for each target type. */
export const TARGET_ICONS: Record<TargetType, string> = {
    EXECUTABLE: 'run',
    STATIC_LIBRARY: 'package',
    SHARED_LIBRARY: 'library',
    MODULE_LIBRARY: 'library',
    OBJECT_LIBRARY: 'file-binary',
    INTERFACE_LIBRARY: 'symbol-interface',
    SYSTEM_LIBRARY: 'circle-outline',
    UTILITY: 'tools',
};

/** Human-readable short label for each target type. */
export const TARGET_TYPE_LABELS: Record<TargetType, string> = {
    EXECUTABLE: 'Executable',
    STATIC_LIBRARY: 'Static',
    SHARED_LIBRARY: 'Shared',
    MODULE_LIBRARY: 'Module',
    OBJECT_LIBRARY: 'Object',
    INTERFACE_LIBRARY: 'Interface',
    SYSTEM_LIBRARY: 'System',
    UTILITY: '',
};
