import * as vscode from 'vscode';
import { setupTests } from '../tests';

let controller: ReturnType<typeof setupTests> | undefined;

export function registerRunTestCommand(context: vscode.ExtensionContext) {
  if (!controller) {
    controller = setupTests(context);
  }
  const disposable = vscode.commands.registerCommand('testdriver.runTest', async (uri: vscode.Uri) => {
    // Find the test item for this file
    const testItem = controller?.items.get(uri.toString());
    if (testItem) {
      // Use the VS Code Testing API to run the test item for maximum compatibility
      await vscode.commands.executeCommand('testing.runTests', [testItem]);
    } else {
      vscode.window.showWarningMessage('Test not found in Test Explorer. Try reloading the window.');
    }
  });
  context.subscriptions.push(disposable);
}
