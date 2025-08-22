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

    // Set context to indicate test panel has been opened for walkthrough completion
    await vscode.commands.executeCommand('setContext', 'testdriver.testPanelOpened', true);

    // Persist this state for future sessions
    await context.globalState.update('testdriver.testPanelOpenedBefore', true);

    return true; // Return success for walkthrough completion
  });
  context.subscriptions.push(disposable);
}
