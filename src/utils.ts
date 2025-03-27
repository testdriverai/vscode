import { exec } from 'node:child_process';
import * as vscode from 'vscode';

export function getActiveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  // No workspace folders open
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }

  // Only one folder in workspace
  if (workspaceFolders.length === 1) {
    return workspaceFolders[0];
  }

  // Multiple folders in workspace - determine which is active based on active editor
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    const activeDocUri = activeEditor.document.uri;
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeDocUri);
    if (activeFolder) {
      return activeFolder;
    }
  }

  // Fallback to first workspace folder if no active editor or if active file
  // isn't within any workspace folder
  return workspaceFolders[0];
}

export function run(command: string, { cwd }: { cwd?: string } = {}) {
  return new Promise<{ stdout: string; stderr: string; error: Error | null }>(
    (resolve) => {
      exec(command, { cwd, encoding: 'utf-8' }, (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          error,
        });
      });
    },
  );
}
