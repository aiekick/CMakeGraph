import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { isWindows, isClInPath, captureVcvarsEnv, findDefaultVcvarsall } from './msvc_env';
import { CMakeDiagnosticsManager } from './diagnostics_manager';
import { appConfigManager } from '../config/app/manager';

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
export interface RunResult {
    success: boolean;
    stdout: string;
    stderr: string;
    code: number | null;
    cancelled: boolean;
}

export interface RunningTask {
    id: number;
    label: string;
    cancel: () => void;
}

interface RunOptions {
    silent?: boolean;
    /** When set, enables CMake diagnostic parsing and resolves relative paths against this dir */
    diagnosticsSourceDir?: string;
}

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------
export class Runner {
    private static readonly MSVC_STATE_KEY = 'CMakeGraph.msvcEnvCache';

    private m_channel: vscode.OutputChannel;
    private m_tasks = new Map<number, RunningTask>();
    private m_nextId = 1;
    private m_msvcEnv: Record<string, string> | null | undefined = undefined;
    private m_state: vscode.Memento | undefined;
    private m_diagnosticsManager: CMakeDiagnosticsManager | undefined;

    private readonly m_onTasksChanged = new vscode.EventEmitter<RunningTask[]>();
    readonly onTasksChanged: vscode.Event<RunningTask[]> = this.m_onTasksChanged.event;

    constructor(aState?: vscode.Memento, aDiagnosticsManager?: CMakeDiagnosticsManager) {
        this.m_state = aState;
        this.m_diagnosticsManager = aDiagnosticsManager;
        const colorize = appConfigManager.settings.colorizeOutput;
        this.m_channel = colorize
            ? vscode.window.createOutputChannel('CMakeGraph', 'cmakegraph-output')
            : vscode.window.createOutputChannel('CMakeGraph');

        // Restore persisted MSVC env from previous session
        if (aState) {
            const persisted = aState.get<Record<string, string> | null>(Runner.MSVC_STATE_KEY);
            if (persisted !== undefined) {
                this.m_msvcEnv = persisted;
            }
        }
    }

    dispose(): void { this.m_channel.dispose(); }

    /** Write a message to the output channel (visible to the user). */
    logToOutput(aMessage: string): void {
        this.m_channel.appendLine(aMessage);
        this.m_channel.show(true);
    }

    getRunningTasks(): RunningTask[] { return [...this.m_tasks.values()]; }

    cancelAll(): void {
        for (const t of this.m_tasks.values()) { t.cancel(); }
    }

    // --------------------------------------------------------
    // MSVC Environment (Windows only)
    // --------------------------------------------------------

    private resolveMsvcEnv(): Record<string, string> | undefined {
        if (!isWindows()) { return undefined; }

        if (this.m_msvcEnv !== undefined) {
            return this.m_msvcEnv ?? undefined;
        }

        if (isClInPath()) {
            this.m_msvcEnv = null;
            this.persistMsvcEnv();
            return undefined;
        }

        const auto = findDefaultVcvarsall();
        if (auto) {
            const env = captureVcvarsEnv(auto.vcvarsall, auto.arch);
            if (env) {
                this.m_channel.appendLine(
                    `ℹ CMakeGraph: MSVC environment auto-detected (${auto.arch})`
                );
                this.m_msvcEnv = env;
                this.persistMsvcEnv();
                return env;
            }
        }

        this.m_msvcEnv = null;
        this.persistMsvcEnv();
        return undefined;
    }

    private persistMsvcEnv(): void {
        this.m_state?.update(Runner.MSVC_STATE_KEY, this.m_msvcEnv);
    }

    // --------------------------------------------------------
    // Silent generic execution (discovery, listing)
    // --------------------------------------------------------
    async exec(aCmd: string, aArgs: string[], aCwd: string): Promise<RunResult> {
        return this.run(aCmd, aArgs, aCwd, { silent: true });
    }

    // --------------------------------------------------------
    // cmake --preset <preset>  OU  cmake -S <src> -B <build>
    // --------------------------------------------------------
    async configure(
        aSourceDir: string | undefined,
        aBuildDir: string | undefined,
        aDefs: Record<string, string> = {},
        aPreset?: string,
        aCmakePath?: string
    ): Promise<RunResult> {
        const cmd = aCmakePath || 'cmake';
        const args: string[] = [];
        if (aPreset) {
            args.push('--preset', aPreset);
        } else {
            args.push('-S', aSourceDir!, '-B', aBuildDir!);
        }
        for (const [k, v] of Object.entries(aDefs)) { args.push(`-D${k}=${v}`); }
        const cwd = aSourceDir ?? '.';
        return this.run(cmd, args, cwd, { diagnosticsSourceDir: cwd });
    }

    // --------------------------------------------------------
    // return build cmd
    // --------------------------------------------------------
    getBuildOptions(
        aTargets: string[],
        aPreset?: string,
        aBuildDir?: string,
        aConfig?: string,
        aJobs?: number
    ): string[] {
        const args: string[] = [];
        args.push('--build');
        if (aPreset) {
            args.push('--preset', aPreset);
        } else {
            args.push(aBuildDir ?? '.');
            if (aJobs && aJobs > 0) { args.push('-j', String(aJobs)); }
        }
        if (aConfig) { args.push('--config', aConfig); }
        for (const t of aTargets) { args.push('--target', t); }
        return args;
    }

    // --------------------------------------------------------
    // cmake --build --preset <preset>  OU  cmake --build <dir>
    // --------------------------------------------------------
    async build(
        aTargets: string[],
        aCmakePath?: string,
        aPreset?: string,
        aFolderDir?: string,
        aBuildDir?: string,
        aConfig?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCmakePath || 'cmake';
        const args = this.getBuildOptions(aTargets, aPreset, aBuildDir, aConfig, aJobs);
        return this.run(cmd, args, aFolderDir ?? '.');
    }

    async rebuild(
        aTargets: string[],
        aCmakePath?: string,
        aPreset?: string,
        aFolderDir?: string,
        aBuildDir?: string,
        aConfig?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCmakePath || 'cmake';
        let args = this.getBuildOptions(aTargets, aPreset, aBuildDir, aConfig, aJobs);
        args.push('--clean-first');
        return this.run(cmd, args, aFolderDir ?? '.');
    }

    async clean(
        aCmakePath?: string,
        aPreset?: string,
        aFolderDir?: string,
        aBuildDir?: string,
        aConfig?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCmakePath || 'cmake';
        const args = this.getBuildOptions(['clean'], aPreset, aBuildDir, undefined, undefined);
        return this.run(cmd, args, aFolderDir ?? '.');
    }

    // --------------------------------------------------------
    // ctest
    // --------------------------------------------------------
    async test(
        aBuildDir: string | undefined,
        aConfig?: string,
        aPreset?: string,
        aCtestPath?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCtestPath || 'ctest';
        const args: string[] = [];
        if (aPreset) {
            args.push('--preset', aPreset);
        } else {
            args.push('--test-dir', aBuildDir!);
            if (aConfig) { args.push('-C', aConfig); }
        }
        if (aJobs && aJobs > 0) { args.push('-j', String(aJobs)); }
        return this.run(cmd, args, aBuildDir ?? '.');
    }

    async testFiltered(
        aBuildDir: string,
        aTestName: string,
        aConfig?: string,
        aCtestPath?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCtestPath || 'ctest';
        const args = ['--test-dir', aBuildDir, '-R', `^${aTestName}$`];
        if (aConfig) { args.push('-C', aConfig); }
        if (aJobs && aJobs > 0) { args.push('-j', String(aJobs)); }
        return this.run(cmd, args, aBuildDir);
    }

    /**
     * Run ctest with a regex filter and --no-tests=ignore.
     * Used by Impacted Targets to test executables by name pattern,
     * silently ignoring targets that are not actual CTest tests.
     */
    async testByRegex(
        aBuildDir: string,
        aRegex: string,
        aConfig?: string,
        aCtestPath?: string,
        aJobs?: number
    ): Promise<RunResult> {
        const cmd = aCtestPath || 'ctest';
        const args = ['--test-dir', aBuildDir, '-R', aRegex, '--no-tests=ignore'];
        if (aConfig) { args.push('-C', aConfig); }
        if (aJobs && aJobs > 0) { args.push('-j', String(aJobs)); }
        return this.run(cmd, args, aBuildDir);
    }

    async listTests(aBuildDir: string, aCtestPath?: string): Promise<RunResult> {
        const cmd = aCtestPath || 'ctest';
        const args = ['--test-dir', aBuildDir, '--show-only=json-v1'];
        return this.run(cmd, args, aBuildDir, { silent: true });
    }

    async listTestsWithPreset(
        aPreset: string,
        aSourceDir: string,
        aCtestPath?: string
    ): Promise<RunResult> {
        const cmd = aCtestPath || 'ctest';
        const args = ['--preset', aPreset, '--show-only=json-v1'];
        return this.run(cmd, args, aSourceDir, { silent: true });
    }

    // --------------------------------------------------------
    // Private
    // --------------------------------------------------------
    private run(aCmd: string, aArgs: string[], aCwd: string, aOpts: RunOptions = {}): Promise<RunResult> {
        const { silent, diagnosticsSourceDir } = aOpts;
        const id = this.m_nextId++;
        const label = `${aCmd} ${aArgs.join(' ')}`;
        const is_win = os.platform() === 'win32';
        const clear_output = !silent && appConfigManager.settings.clearOutputBeforeRun;

        const msvc_env = this.resolveMsvcEnv();

        // If this is a configure run, clear previous diagnostics
        const parse_diag = diagnosticsSourceDir && this.m_diagnosticsManager;
        if (parse_diag) {
            this.m_diagnosticsManager!.clear();
        }

        return new Promise(resolve => {
            if (clear_output) { this.m_channel.clear(); }
            if (!silent) {
                this.m_channel.appendLine(`> ${label}`);
                this.m_channel.appendLine('');
                this.m_channel.show(true);
            }

            // On Windows, merge MSVC env with process.env so cmake/ctest can still
            // be found in PATH even when vcvarsall provides its own environment.
            const spawn_env = msvc_env ? { ...process.env, ...msvc_env } : undefined;

            const finish = (result: RunResult): void => {
                this.m_tasks.delete(id);
                this.m_onTasksChanged.fire(this.getRunningTasks());
                resolve(result);
            };

            // Validate cwd exists — spawn reports misleading ENOENT on the command
            // itself when the working directory doesn't exist.
            const resolved_cwd = path.resolve(aCwd);
            if (!fs.existsSync(resolved_cwd)) {
                const msg = `Working directory does not exist: ${resolved_cwd}`;
                if (!silent) {
                    this.m_channel.appendLine(msg);
                    vscode.window.showErrorMessage(msg);
                }
                finish({ success: false, stdout: '', stderr: msg, code: null, cancelled: false });
                return;
            }

            const proc: ChildProcess = is_win
                ? spawn(aCmd, aArgs, { cwd: resolved_cwd, shell: false, env: spawn_env })
                : spawn(aCmd, aArgs, { cwd: resolved_cwd, shell: false, detached: true });

            let stdout = '', stderr = '', killed = false;

            // Line buffer for diagnostic parsing (data chunks don't align with lines)
            let line_buf = '';

            const kill_proc = (): void => {
                if (is_win) {
                    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: false });
                } else {
                    try { process.kill(-proc.pid!, 'SIGTERM'); } catch { proc.kill(); }
                }
            };

            const task: RunningTask = {
                id,
                label,
                cancel: () => {
                    killed = true;
                    kill_proc();
                    if (!silent) { this.m_channel.appendLine(`⊘ Cancelled: ${label}`); }
                },
            };

            this.m_tasks.set(id, task);
            this.m_onTasksChanged.fire(this.getRunningTasks());

            /** Feed text to the diagnostic parser, handling partial lines */
            const feed_diagnostics = (text: string): void => {
                if (!parse_diag) { return; }
                line_buf += text;
                const lines = line_buf.split('\n');
                // Keep the last (potentially incomplete) chunk in the buffer
                line_buf = lines.pop()!;
                for (const line of lines) {
                    this.m_diagnosticsManager!.parseLine(line, diagnosticsSourceDir!);
                }
            };

            proc.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stdout += text;
                if (!silent) { this.m_channel.append(text); }
                feed_diagnostics(text);
            });
            proc.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stderr += text;
                if (!silent) { this.m_channel.append(text); }
                feed_diagnostics(text);
            });
            proc.on('error', err => {
                const msg = `Unable to launch ${aCmd}: ${err.message}`;
                if (!silent) {
                    this.m_channel.appendLine(msg);
                    vscode.window.showErrorMessage(msg);
                }
                finish({ success: false, stdout, stderr: msg, code: null, cancelled: false });
            });
            proc.on('close', (code: number | null) => {
                // Flush remaining line buffer to diagnostics parser
                if (parse_diag && line_buf.length > 0) {
                    this.m_diagnosticsManager!.parseLine(line_buf, diagnosticsSourceDir!);
                    line_buf = '';
                }
                if (parse_diag) {
                    this.m_diagnosticsManager!.finalize(diagnosticsSourceDir!);
                }

                if (killed) {
                    finish({ success: false, stdout, stderr, code, cancelled: true });
                } else {
                    const success = code === 0;
                    if (!silent) {
                        this.m_channel.appendLine('');
                        this.m_channel.appendLine(success
                            ? `✓ ${aCmd} completed (code ${code})`
                            : `✗ ${aCmd} failed (code ${code})`
                        );
                    }
                    finish({ success, stdout, stderr, code, cancelled: false });
                }
            });
        });
    }
}
