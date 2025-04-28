import * as vscode from 'vscode';
import { registerChatParticipant } from './chat';
import { registerCommands } from './commands';
import { validate } from './schema';
import { setupTests } from './tests';
export function deactivate() {}

export async function activate(context: vscode.ExtensionContext) {
  const isFirstInstall = context.globalState.get(
    'testdriver.firstInstall',
    true,
  );

  if (isFirstInstall) {
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriverai.testdriver#gettingStarted',
      false,
    );
    context.globalState.update('testdriver.firstInstall', false);
  }

  registerCommands();
  registerChatParticipant(context);
  validate(context);
  const controller = setupTests();

  context.subscriptions.push(controller);
}
