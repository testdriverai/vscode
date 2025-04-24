import * as vscode from 'vscode';
import { initialize } from './initialize';
import { install } from './install';
import { testdriverCommand } from './chat';
import { getChatInstance } from '../cli';

const registerCtrlPCommands = () => {
  const chatCommands = ['dry', 'try'] as const;

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
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Running TestDriver codeblock...",
          cancellable: true,
        },
        async (progress, token) => {
          const instance = await getChatInstance();

          token.onCancellationRequested(() => {
            instance.destroy();
          });

          instance.on("status", (status: string) => {
            progress.report({ message: status });
          });

          await instance.run(`/yaml ${encodeURIComponent(yaml)}`);
        }
      );
    },
  );
};

export const registerCommands = () => {
  registerCtrlPCommands();
  registerOtherCommands();

  vscode.commands.registerCommand('testdriver.walkthrough', () => {
    console.log('Opening walkthrough');

    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriverai.testdriver#gettingStarted',
      false,
    );
  });
  vscode.commands.registerCommand('testdriver.walkthroughDeploy', () => {
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriverai.testdriver#deploy',
      false,
    );
  });
  vscode.commands.registerCommand('testdriver.walkthroughGenerate', () => {
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriverai.testdriver#generate',
      false,
    );
  });
  vscode.commands.registerCommand('testdriver.openDocsAtCI', () => {
    const docsUrl = 'https://testdriver.mintlify.app/getting-started/ci';
    vscode.env.openExternal(vscode.Uri.parse(docsUrl));
  });
  vscode.commands.registerCommand('testdriver.openDocsRoot', () => {
    const docsUrl = 'https://testdriver.mintlify.app';
    vscode.env.openExternal(vscode.Uri.parse(docsUrl));
  });
};
