export interface TextEdit {
    range: {
        start: {
            line: number;
            character: number;
        };
        end: {
            line: number;
            character: number;
        };
    };
    newText: string;
}
export interface WorkspaceEdit {
    changes?: Record<string, TextEdit[]>;
    documentChanges?: Array<{
        textDocument: {
            uri: string;
        };
        edits: TextEdit[];
    }>;
}
export declare function applyWorkspaceEdit(edit: WorkspaceEdit): string[];
//# sourceMappingURL=edit-apply.d.ts.map