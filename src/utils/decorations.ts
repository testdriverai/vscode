import * as vscode from 'vscode';
import * as path from 'path';

// Decoration types for command status indicators
let successDecorationType: vscode.TextEditorDecorationType;
let failureDecorationType: vscode.TextEditorDecorationType;
let extensionContext: vscode.ExtensionContext;

export function initializeDecorations(context?: vscode.ExtensionContext) {
  if (context) {
    extensionContext = context;
  }

  // Create success decoration with checkmark
  successDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: extensionContext
      ? vscode.Uri.file(path.join(extensionContext.extensionPath, 'media', 'check.svg'))
      : vscode.Uri.file(path.join(__dirname, '../..', 'media', 'check.svg')),
    gutterIconSize: 'contain',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    overviewRulerColor: '#28a745',
  });

  // Create failure decoration with X mark
  failureDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: extensionContext
      ? vscode.Uri.file(path.join(extensionContext.extensionPath, 'media', 'error.svg'))
      : vscode.Uri.file(path.join(__dirname, '../..', 'media', 'error.svg')),
    gutterIconSize: 'contain',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    overviewRulerColor: '#dc3545',
  });
}

export function disposeDecorations() {
  if (successDecorationType) {
    successDecorationType.dispose();
  }
  if (failureDecorationType) {
    failureDecorationType.dispose();
  }
}

export interface CommandStatus {
  line: number;
  column: number;
  status: 'success' | 'failure' | 'running';
  message?: string;
}

// Track command statuses per file
const fileCommandStatuses = new Map<string, CommandStatus[]>();

export function addCommandStatus(fileUri: string, status: CommandStatus) {
  if (!fileCommandStatuses.has(fileUri)) {
    fileCommandStatuses.set(fileUri, []);
  }

  const statuses = fileCommandStatuses.get(fileUri)!;

  // Remove any existing status for the same line
  const existingIndex = statuses.findIndex(s => s.line === status.line);
  if (existingIndex >= 0) {
    statuses.splice(existingIndex, 1);
  }

  statuses.push(status);
  updateDecorations(fileUri);
}

export function clearCommandStatuses(fileUri?: string) {
  if (fileUri) {
    fileCommandStatuses.delete(fileUri);
    updateDecorations(fileUri);
  } else {
    fileCommandStatuses.clear();
    // Clear decorations for all open editors
    vscode.window.visibleTextEditors.forEach(editor => {
      updateDecorations(editor.document.uri.toString());
    });
  }
}

function updateDecorations(fileUri: string) {
  const statuses = fileCommandStatuses.get(fileUri) || [];

  // Find the editor for this file
  const editor = vscode.window.visibleTextEditors.find(
    e => e.document.uri.toString() === fileUri
  );

  if (!editor) {
    return;
  }

  const successRanges: vscode.DecorationOptions[] = [];
  const failureRanges: vscode.DecorationOptions[] = [];

  for (const status of statuses) {
    if (status.status === 'running') {
      continue; // Don't show decorations for running commands
    }

    const range = new vscode.Range(status.line, 0, status.line, 0);
    const decorationOptions: vscode.DecorationOptions = {
      range,
      hoverMessage: status.message || (status.status === 'success' ? 'Command succeeded' : 'Command failed'),
    };

    if (status.status === 'success') {
      successRanges.push(decorationOptions);
    } else if (status.status === 'failure') {
      failureRanges.push(decorationOptions);
    }
  }

  editor.setDecorations(successDecorationType, successRanges);
  editor.setDecorations(failureDecorationType, failureRanges);
}

// Update decorations when the active editor changes
export function registerDecorationUpdates() {
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      updateDecorations(editor.document.uri.toString());
    }
  });

  vscode.workspace.onDidCloseTextDocument((document) => {
    // Clean up when a document is closed
    fileCommandStatuses.delete(document.uri.toString());
  });
}
