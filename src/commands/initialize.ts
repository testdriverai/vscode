import * as vscode from 'vscode';
import { getExecutablePath, getPackageJsonVersion, compareVersions } from '../npm';

export const initialize = async () => {

  console.log('Initializing TestDriver...');

  const requiredVersion = '5.3.15';

  let testdriverPath;
  try {
    testdriverPath = getExecutablePath();
  } catch(err) {
    // display error to user
    vscode.window.showErrorMessage(
      '`testdriverai` executable not found in PATH. Install `testdriverai` globally using `npm install -g testdriverai@beta`',
    );
    throw new Error('`testdriverai` not found in PATH. Install `testdriverai` globally using `npm install -g testdriverai@beta`');
  }

  const testdriverVersion = getPackageJsonVersion();

  if (compareVersions(testdriverVersion, requiredVersion) <= 0) {
    const message = `testdriverai version must be greater than ${requiredVersion}. Current version: ${testdriverVersion}`;
    console.error('Error: testdriverai version is too old. Please update to the latest version.');
    vscode.window.showErrorMessage(message);
    throw new Error(message);
  }

  if (testdriverVersion) {
    console.log(`Using testdriverai version: ${testdriverVersion}`);
  }


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

  if (!workspaceFolder) {
    await vscode.window.showErrorMessage('No workspace folder found');
    return;
  }

  const terminal = vscode.window.createTerminal('TestDriver Init');

  const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.terminal === terminal) {
        disposable.dispose();
      }
    });

  terminal.sendText(`${testdriverPath} init`);
  terminal.show();

};
