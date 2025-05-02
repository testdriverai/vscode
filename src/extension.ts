import * as vscode from 'vscode';
import { init } from './utils/init';
import { setupTests } from './tests';
import { track, logger } from './utils/logger';
import { validate } from './utils/schema';
import { registerCommands } from './commands';
import { registerChatParticipant } from './chat';

export function deactivate() {}

export async function activate(context: vscode.ExtensionContext) {
  init(context);

  const isFirstInstall = context.globalState.get(
    'testdriver.firstInstall',
    true,
  );

  logger.info('TestDriverAI extension activated', {
    isFirstInstall,
  });

  if (isFirstInstall) {
    track({ event: 'extension.installed' });
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriverai.testdriver#gettingStarted',
      false,
    );
    context.globalState.update('testdriver.firstInstall', false);
  }

  track({ event: 'extension.activated' });
  registerCommands();
  registerChatParticipant(context);
  const controller = setupTests();

  try {
    registerCommands();
  } catch (err) {
    logger.error('Error registering commands', {
      error: err,
    });
  }

  try {
    registerChatParticipant(context);
  } catch (err) {
    logger.error('Error registering chat participant', {
      error: err,
    });
  }

  try {
    validate(context);
  } catch (err) {
    logger.error('Error validating extension context', {
      error: err,
    });
  }

  try {
    const controller = setupTests();
    context.subscriptions.push(controller);
  } catch (err) {
    logger.error('Error setting up tests', {
      error: err,
    });
  }
}
