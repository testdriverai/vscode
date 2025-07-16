import * as vscode from 'vscode';
import { logger, track } from '../utils/logger';

export const registerCommands = () => {

  vscode.commands.registerCommand('testdriver.walkthrough', () => {
    logger.info('Opening walkthrough');
    track({ event: 'walkthrough.started' });

    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriverai.testdriver#gettingStarted',
      false,
    );
  });
  vscode.commands.registerCommand('testdriver.openDocsRoot', () => {
    track({ event: 'docs.root' });

    const docsUrl = 'https://testdriver.mintlify.app';
    vscode.env.openExternal(vscode.Uri.parse(docsUrl));
  });
};
