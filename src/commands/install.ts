import * as vscode from 'vscode';

export const install = async () => {

  const terminal = vscode.window.createTerminal('Testdriver Install');
  terminal.sendText('npm install -g testdriverai@beta');
  terminal.show();

};
