import * as vscode from 'vscode';
import { initialize } from './initialize';
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
};

const registerOtherCommands = () => {
  vscode.commands.registerCommand(
    'testdriver.codeblock.run',
    async (yaml: string) => {
      console.log('Running codeblock');
      console.log(yaml);
      const instance = await getChatInstance();
      await instance.run(`/yaml ${encodeURIComponent(yaml)}`);
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
      true
    );
  });
  vscode.commands.registerCommand('testdriver.walkthroughDeploy', () => {

    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriverai.testdriver#deploy',
      true
    );
  });
};
