import * as vscode from 'vscode';
import { init as initEnv, getEnv } from './env';
import { init as initLogger, logger } from './logger';

let initialized = false;
export function init(context: vscode.ExtensionContext) {
  if (initialized) {
    return { env: getEnv(), logger };
  }

  initialized = true;
  const env = initEnv(context);
  initLogger(env);

  return { env, logger };
}
