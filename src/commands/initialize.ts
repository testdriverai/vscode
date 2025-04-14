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
  console.log('folder', folder);

  // Check if npm is installed
  statusBar = vscode.window.setStatusBarMessage('Checking npm...');
  const { error: npmError, stdout: npmVersion } = await run('npm -v', {
    cwd: folder,
  });
  statusBar.dispose();
  console.log('npmVersion', npmVersion);
  if (npmError) {
    await vscode.window.showErrorMessage('npm is not installed');
    return;
  }

  // Check if testdriverai is installed
  statusBar = vscode.window.setStatusBarMessage('Checking testdriverai...');
  const {
    error: tdError,
    stdout: tdStdout,
    stderr: tdStderr,
  } = await run('testdriverai --help', { cwd: folder });
  statusBar.dispose();

  console.log({ error: tdError, stdout: tdStdout, stderr: tdStderr });
  if (tdError) {
    statusBar = vscode.window.setStatusBarMessage('Installing testdriverai...');
    const { error: installError } = await run(
      'npm install -g testdriverai@beta',
      { cwd: folder },
    );
    statusBar.dispose();
    if (installError) {
      await vscode.window.showErrorMessage('Failed to install testdriverai');
      return;
    }
  }

  // const testdriverDir = vscode.Uri.parse('testdriver');
  // const stat = await vscode.workspace.fs.stat(testdriverDir);
  // console.log({ stat });
  // Check if Testdriver is already initialized
  // if (stat) {
  //   await vscode.window.showInformationMessage(
  //     'Skipping, Testdriver is already initialized in this workspace',
  //   );
  //   return;
  // }

  statusBar = vscode.window.setStatusBarMessage(
    'Initializing Testdriver project...',
  );
  const terminal = vscode.window.createTerminal('Testdriver');
  const promise = new Promise<void>((resolve) => {
    const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.terminal === terminal) {
        disposable.dispose();
        resolve();
      }
    });
  });
  terminal.sendText('testdriverai init');
  terminal.show();

  await promise.finally(() => {
    statusBar.dispose();
  });
};
