import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { RunResult } from './runner';

// ------------------------------------------------------------
// CMake debugger (cmake >= 3.27, --debugger --debugger-pipe)
// CMake speaks DAP directly on the pipe, so VS Code connects to it
// as a named pipe debug adapter.
// ------------------------------------------------------------

export const CMAKE_DEBUG_TYPE = 'cmakegraph';

/** Line printed by cmake once the pipe is ready for a client */
const WAITING_FOR_CLIENT = 'Waiting for debugger client to connect...';

/** Starts cmake with the debugger listening on aPipeName, forwarding its output to aOnOutput */
export type StartConfigureFn = (aPipeName: string, aOnOutput: (aText: string) => void) => Promise<RunResult>;

export function getDebuggerPipeName(): string {
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\cmakegraph-debugger-${randomUUID()}`
        : `/tmp/cmakegraph-debugger-${randomUUID()}`;
}

export class CMakeDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(private readonly m_startConfigure: StartConfigureFn) { }

    async createDebugAdapterDescriptor(aSession: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor> {
        const pipe_name: string = aSession.configuration.pipeName ?? getDebuggerPipeName();

        // Wait until cmake listens on the pipe, or fail if it exits before
        await new Promise<void>((resolve, reject) => {
            let output = '';
            let ready = false;
            this.m_startConfigure(pipe_name, aText => {
                if (ready) { return; }
                output += aText;
                if (output.includes(WAITING_FOR_CLIENT)) {
                    ready = true;
                    resolve();
                }
            }).then(aResult => {
                if (!ready) {
                    reject(new Error(aResult.cancelled
                        ? 'CMakeGraph: configure cancelled'
                        : 'CMakeGraph: cmake exited before the debugger was ready (CMake >= 3.27 is required)'));
                }
            });
        });

        return new vscode.DebugAdapterNamedPipeServer(pipe_name);
    }
}
