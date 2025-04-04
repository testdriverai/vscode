import * as vscode from 'vscode';
import { initialize } from './initialize';
import { testdriverCommand } from './chat';

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
    async (yaml: string, workspace: vscode.WorkspaceFolder) => {
      console.log('Running codeblock', yaml, 'workspace', workspace);
      const terminal = vscode.window.createTerminal({
        name: 'TestDriver',
        cwd: workspace.uri.fsPath,
      });
      terminal.show();
      terminal.sendText(`testdriverai run ${yaml}`, true);
    },
  );
};

export const registerCommands = () => {
  registerCtrlPCommands();
  registerOtherCommands();
};
