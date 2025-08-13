import * as vscode from 'vscode';

/**
 * Ensures VS Code is in vertical layout (horizontal editor group split)
 * where editor groups are arranged top and bottom
 */
export async function ensureVerticalLayout(): Promise<void> {
  try {
    // Close any open panels first
    await vscode.commands.executeCommand('workbench.action.closePanel');

    // First, ensure we're in a single editor group state
    await vscode.commands.executeCommand('workbench.action.editorLayoutSingle');
    
    // Give a small delay for the layout reset to take effect
    await new Promise(resolve => setTimeout(resolve, 50));

    // Focus on the first editor group
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');

    // Explicitly set the editor layout to be vertically stacked (2 rows, 1 column)
    await vscode.commands.executeCommand('workbench.action.editorLayoutTwoRows');

    // Give a small delay for the layout change to take effect
    await new Promise(resolve => setTimeout(resolve, 100));

  } catch (error) {
    console.log('Could not ensure vertical layout:', error);
  }
}

/**
 * Opens a document in the top editor group (for VM windows)
 */
export async function openInTopGroup(document: vscode.TextDocument | vscode.Uri, options?: vscode.TextDocumentShowOptions): Promise<vscode.TextEditor | undefined> {
  try {
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');

    const uri = document instanceof vscode.Uri ? document : document.uri;
    return await vscode.window.showTextDocument(uri, {
      ...options,
      viewColumn: vscode.ViewColumn.One
    });
  } catch (error) {
    console.log('Could not open in top group:', error);
    return undefined;
  }
}

/**
 * Opens a document in the bottom editor group (for test files)
 */
export async function openInBottomGroup(document: vscode.TextDocument | vscode.Uri, options?: vscode.TextDocumentShowOptions): Promise<vscode.TextEditor | undefined> {
  try {
    // Ensure we have vertical layout first
    await ensureVerticalLayout();

    // Focus on the second editor group (bottom in vertical layout)
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');

    const uri = document instanceof vscode.Uri ? document : document.uri;
    return await vscode.window.showTextDocument(uri, {
      ...options,
      viewColumn: vscode.ViewColumn.Two
    });
  } catch (error) {
    console.log('Could not open in bottom group:', error);
    return undefined;
  }
}
