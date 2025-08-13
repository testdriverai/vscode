import * as vscode from 'vscode';
import { logger, track } from '../utils/logger';
import { registerRunTestCommand } from './runTest';
import { registerChatCommand } from './chat';

export const registerCommands = () => {
  vscode.commands.registerCommand('testdriver.walkthrough', () => {
    logger.info('Opening walkthrough');
    track({ event: 'walkthrough.started' });
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriver.testdriver#gettingStarted',
      false,
    );
  });
  vscode.commands.registerCommand('testdriver.openDocsRoot', () => {
    track({ event: 'docs.root' });
    const docsUrl = 'https://testdriver.mintlify.app';
    vscode.env.openExternal(vscode.Uri.parse(docsUrl));
  });
};

export const registerTestdriverRunTest = (context: vscode.ExtensionContext) => {
  registerRunTestCommand(context);
};

export const registerTestdriverChat = (context: vscode.ExtensionContext) => {
  registerChatCommand(context);
};
