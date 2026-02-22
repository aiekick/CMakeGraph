import * as vscode from 'vscode';

/**
 * Abstract base class for tree data providers that support text filtering.
 * Subclasses implement `onFilterChanged()` to rebuild their tree when the filter changes.
 */
export abstract class FilterableTreeProvider<T> implements vscode.TreeDataProvider<T> {
    protected readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChangeTreeData.event;

    protected m_filter = '';

    setFilter(aPattern: string): void {
        this.m_filter = aPattern.toLowerCase();
        this.onFilterChanged();
    }

    clearFilter(): void {
        this.m_filter = '';
        this.onFilterChanged();
    }

    get currentFilter(): string {
        return this.m_filter;
    }

    get hasFilter(): boolean {
        return this.m_filter.length > 0;
    }

    /** Called when the filter changes. Subclasses should rebuild their tree and fire the event. */
    protected abstract onFilterChanged(): void;

    abstract getTreeItem(element: T): vscode.TreeItem;
    abstract getChildren(element?: T): T[];
}
