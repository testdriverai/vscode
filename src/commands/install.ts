import * as vscode from 'vscode';
import { track } from '../utils/logger';

export const install = async () => {
  track({ event: 'command.install' });
  const terminal = vscode.window.createTerminal('Testdriver Install');
  terminal.sendText('npm install -g testdriverai@beta');
  terminal.show();
};
