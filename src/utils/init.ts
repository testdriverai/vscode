import * as vscode from 'vscode';
import { init as initEnv } from './env';
import { init as initLogger } from './logger';

let initialized = false;
export function init(context: vscode.ExtensionContext) {
  if (!initialized) {
    initialized = true;
    const env = initEnv(context);
    initLogger(context, env);
  }
}
