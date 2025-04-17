import * as vscode from 'vscode';
import { run } from '../utils';

export const initialize = async () => {
  let workspaceFolder: vscode.WorkspaceFolder | undefined = undefined;

  if (
    !vscode.workspace.workspaceFolders ||
    vscode.workspace.workspaceFolders.length === 0
  ) {
    await vscode.window.showErrorMessage('No workspace folder found');
    return;
  }

  if (vscode.workspace.workspaceFolders.length === 1) {
    workspaceFolder = vscode.workspace.workspaceFolders[0];
  } else {
    await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'Select a workspace folder',
    });
  }

  let statusBar = vscode.window.setStatusBarMessage(
    'Initializing Testdriver...',
  );

  // Check workspace folder
  statusBar.dispose();

  if (!workspaceFolder) {
    await vscode.window.showErrorMessage('No workspace folder found');
    return;
  }

  const folder = workspaceFolder.uri.fsPath;

  const terminal = vscode.window.createTerminal('Testdriver');
  const promise = new Promise<void>((resolve) => {
    const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.terminal === terminal) {
        disposable.dispose();
        resolve();
      }
    });
  });
  const pathToBinary = require.resolve('testdriverai');

  terminal.sendText(`node ${pathToBinary} init`);
  terminal.show();

  await promise.finally(() => {
    statusBar.dispose();
  });
};
