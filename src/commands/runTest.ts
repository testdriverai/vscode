import * as vscode from 'vscode';
import { setupTests } from '../tests';

let controller: ReturnType<typeof setupTests> | undefined;

export function registerRunTestCommand(context: vscode.ExtensionContext) {
  if (!controller) {
    controller = setupTests(context);
  }
  const disposable = vscode.commands.registerCommand('testdriver.runTest', async (_uri?: vscode.Uri) => {
    // Open the VS Code Test Explorer panel
    await vscode.commands.executeCommand('workbench.view.testing.focus');
  });
  context.subscriptions.push(disposable);
}
