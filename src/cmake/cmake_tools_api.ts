import * as vscode from 'vscode';
import { Version, getCMakeToolsApi, Project } from 'vscode-cmake-tools';

export class CMakeToolsIntegrationManager {
    private m_project: Project | undefined;
    private m_disposables: vscode.Disposable[] = [];

    constructor(private readonly m_onConfigureDone: (aFolderDir: string, aBuildDir: string, aBuildType: string, aBuildPreset: string) => void) { }

    public async watch(aContext: vscode.ExtensionContext): Promise<void> {
        // 1. init at start
        await this.init();

        // 2. security : re connect if user change the folder
        aContext.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.init())
        );

        // 3. security : reconnection if cmake-tools is activated after us
        aContext.subscriptions.push(
            vscode.extensions.onDidChange(() => this.init())
        );

        aContext.subscriptions.push(this);
    }

    private async init(): Promise<void> {
        // clearing old connection
        this.disposeProject();

        try {
            const api = await getCMakeToolsApi(Version.v1);
            if (!api) {
                console.log('[CMakeGraph] CMake-Tools API not available');
                return;
            }
            console.log(`[CMakeGraph] Connected to CMake-Tools with Api v${api.version}`);

            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                return;
            }

            this.m_project = await api.getProject(folder.uri);

            if (this.m_project) {
                const notifyState = async () => {
                    const generator = this.m_project?.configurePreset?.generator;
                    console.log(`[CMakeGraph] generator : ${generator}`);
                    const folder_dir = folder.uri.fsPath;
                    console.log(`[CMakeGraph] folder_dir : ${folder_dir}`);
                    const build_dir = await this.m_project?.getBuildDirectory();
                    console.log(`[CMakeGraph] build_dir : ${build_dir}`);
                    const build_preset = this.m_project?.buildPreset?.name ?? '';
                    console.log(`[CMakeGraph] build_preset : ${build_preset}`);
                    let build_type = generator === "Ninja Multi-Config"
                        ? ''
                        : await this.m_project?.getActiveBuildType() ?? '';
                    console.log(`[CMakeGraph] build_type : ${build_type}`);
                    if (build_dir) {
                        this.m_onConfigureDone(folder_dir, build_dir, build_type, build_preset);
                    }
                };

                // Subscribe to future code model changes
                const sub = this.m_project.onCodeModelChanged(() => notifyState());
                this.m_disposables.push(sub);

                // Read current state immediately (cmake-tools may already be configured)
                await notifyState();
            }
        } catch (err) {
            console.log('[CMakeGraph] CMake-Tools connection failed:', err);
        }
    }

    private disposeProject() {
        this.m_disposables.forEach(d => d.dispose());
        this.m_disposables = [];
        this.m_project = undefined;
    }

    public dispose() {
        this.disposeProject();
    }
}
