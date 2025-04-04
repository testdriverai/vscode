import * as vscode from 'vscode';
import { registerChatParticipant } from './chat';
import { registerCommands } from './commands';
import { setupTests } from './tests';
export function deactivate() {}

export async function activate(context: vscode.ExtensionContext) {
  registerCommands();
  registerChatParticipant(context);
  const controller = setupTests();

  context.subscriptions.push(controller);
}
