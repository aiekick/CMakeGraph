import * as vscode from 'vscode';
import { AppConfig as AppConfigTypes } from './types';
import { AppConfigDefault as DefaultConfig } from './default';

const CONFIG_SECTION = 'CMakeGraph';

// The AppConfigManager is responsible for loading, storing and updating
// the application-level (global/user) settings and providing a centralized
// API to access these settings in the extension.
export class AppConfigManager implements vscode.Disposable {
    private _settings: AppConfigTypes.Settings;
    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

    constructor() {
        this._settings = DefaultConfig;
        this.loadConfig();
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(aEvent => {
                if (aEvent.affectsConfiguration(CONFIG_SECTION)) {
                    this.loadConfig();
                    this._onDidChange.fire();
                }
            }),
        );
    }

    dispose(): void {
        for (const d of this._disposables) { d.dispose(); }
        this._onDidChange.dispose();
    }

    // ---- Read ----

    get settings(): AppConfigTypes.Settings {
        return this._settings;
    }

    // ---- Write ----

    // Update a single app-level setting (stored in user/global settings).
    async updateSetting(aKey: string, aValue: unknown): Promise<void> {
        await vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .update(aKey, aValue, vscode.ConfigurationTarget.Global);
        // loadConfig() will be triggered automatically by onDidChangeConfiguration
    }

    // ---- Internal ----

    private loadConfig(): void {
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        this._settings = {
            clearOutputBeforeRun: cfg.get<boolean>('clearOutputBeforeRun', DefaultConfig.clearOutputBeforeRun),
            colorizeOutput: cfg.get<boolean>('colorizeOutput', DefaultConfig.colorizeOutput),
        };
    }
}

export const appConfigManager = new AppConfigManager();
