import * as vscode from 'vscode';

export type Env = Lowercase<keyof typeof vscode.ExtensionMode>;
let _env: Env = 'production';

export function init(context: vscode.ExtensionContext) {
  _env = Object.entries(vscode.ExtensionMode)
    .find(([_, value]) => context.extensionMode === value)![0]
    .toLowerCase() as Env;

  return _env;
}

export const getEnv = () => _env;
