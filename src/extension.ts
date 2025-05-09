import * as vscode from 'vscode';
import * as path from 'path';

import { init } from './utils/init';
import { setupTests } from './tests';
import { track, logger, init as loggerInit } from './utils/logger';
import { getEnv } from './utils/env';
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

  vscode.workspace.onDidOpenTextDocument((doc) => {
    const isYaml = doc.languageId === 'yaml' || doc.fileName.endsWith('.yaml');
    const isTestDriverYaml = doc.uri.fsPath.includes(path.join('testdriver', ''));

    if (isYaml && isTestDriverYaml) {
      const yamlExt = vscode.extensions.getExtension('redhat.vscode-yaml');

      if (!yamlExt) {
        vscode.window.showInformationMessage(
          'TestDriver: Install "YAML by Red Hat" for schema validation and better editing in TestDriver YAML files.',
          'Install'
        ).then(selection => {
          if (selection === 'Install') {
            vscode.commands.executeCommand(
              'workbench.extensions.installExtension',
              'redhat.vscode-yaml'
            );
          }
        });
      }
    }
  });

  const consent = context.globalState.get<string>('testdriver.analyticsConsent');

  if (consent === undefined) {
    const result = await vscode.window.showInformationMessage(
      'Help us improve TestDriver by sending anonymous usage data.',
      'Yes, allow',
      'No, thanks'
    );

    if (result === 'Yes, allow') {
      await context.globalState.update('testdriver.analyticsConsent', 'granted');
      vscode.window.showInformationMessage('Thank you! Analytics enabled.');
    } else if (result === 'No, thanks') {
      await context.globalState.update('testdriver.analyticsConsent', 'denied');
    }
  }

  const disposable = vscode.commands.registerCommand('testdriver.toggleAnalytics', async () => {
    const current = context.globalState.get<string>('testdriver.analyticsConsent') || 'denied';
    const next = current === 'granted' ? 'denied' : 'granted';

    await context.globalState.update('testdriver.analyticsConsent', next);
    vscode.window.showInformationMessage(
      `Analytics ${next === 'granted' ? 'enabled' : 'disabled'}.`
    );
    const env = getEnv();
    loggerInit(context, env)
  });

  context.subscriptions.push(disposable);
}
