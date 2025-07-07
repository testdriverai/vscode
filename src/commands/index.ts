import * as vscode from 'vscode';
import { install } from './install';
import { logger, track } from '../utils/logger';
import { getChatInstance } from '../cli';
import { initialize } from './initialize';
import { testdriverCommand } from './chat';

const registerCtrlPCommands = () => {
  const chatCommands = ['dry', 'explore'] as const;

  for (const command of chatCommands) {
    vscode.commands.registerCommand(
      `testdriver.${command}`,
      testdriverCommand(command),
    );
  }

  vscode.commands.registerCommand('testdriver.init', initialize);
  vscode.commands.registerCommand('testdriver.install', install);
};

const registerOtherCommands = () => {
  vscode.commands.registerCommand(
    'testdriver.codeblock.run',
    async (yaml: string) => {
      track({ event: 'command.codeblock.run' });
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Running TestDriver codeblock...',
          cancellable: true,
        },
        async (progress, token) => {
          try {
            const instance = await getChatInstance();

            token.onCancellationRequested(() => {
              instance.destroy();
            });

            instance.on('status', (status: string) => {
              progress.report({ message: status });
            });

            await instance.run(`/yaml ${encodeURIComponent(yaml)}`);
          } catch (err) {
            logger.error('Error running TestDriver codeblock', {
              error: err,
            });
          }
        },
      );
    },
  );
};

export const registerCommands = () => {
  registerCtrlPCommands();
  registerOtherCommands();

  vscode.commands.registerCommand('testdriver.walkthrough', () => {
    logger.info('Opening walkthrough');
    track({ event: 'walkthrough.started' });

    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriverai.testdriver#gettingStarted',
      false,
    );
  });
  vscode.commands.registerCommand('testdriver.openDocsAtCI', () => {
    track({ event: 'docs.ci' });

    const docsUrl = 'https://testdriver.mintlify.app/getting-started/ci';
    vscode.env.openExternal(vscode.Uri.parse(docsUrl));
  });
  vscode.commands.registerCommand('testdriver.openDocsRoot', () => {
    track({ event: 'docs.root' });

    const docsUrl = 'https://testdriver.mintlify.app';
    vscode.env.openExternal(vscode.Uri.parse(docsUrl));
  });
};
