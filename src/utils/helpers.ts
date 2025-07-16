import path from 'node:path';
import * as vscode from 'vscode';
import { exec } from 'node:child_process';
// EventEmitter import removed; no longer needed
import { logger } from './logger';

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

export function exists(uri: vscode.Uri) {
  return vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );
}

export function getUri(
  relativePath: string,
  workspaceFolder: vscode.WorkspaceFolder,
) {
  return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, relativePath));
}

export async function isFileType(
  type: vscode.FileType,
  file: vscode.Uri,
): Promise<boolean | null> {
  return vscode.workspace.fs.stat(file).then(
    (stat) => stat.type === type,
    () => null,
  );
}

export function beautifyFilename(name: string) {
  return name
    .split('/')
    .pop()!
    .replace(/\.[a-zA-Z0-9]$/, '')
    .replace(/[_-]/g, ' ');
}

export const getActiveWorkspaceFolder = () => {
  const workspaces = vscode.workspace.workspaceFolders;
  if (!workspaces || workspaces.length === 0) {
    return null;
  }

  const activeEditorPath = vscode.window.activeTextEditor?.document.uri.path;

  if (!activeEditorPath) {
    return workspaces[0];
  }

  const matchingWorkspace = workspaces.find((wsFolder) => {
    const relative = path.relative(wsFolder.uri.fsPath, activeEditorPath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });

  logger.info('Matching workspace:', matchingWorkspace);

  return matchingWorkspace ?? workspaces[0];
};

// MarkdownStreamParser and related types removed; agent now emits codeblock events directly
