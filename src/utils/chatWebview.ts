import * as vscode from 'vscode';
import * as path from 'path';
import { WebviewHelper } from './webviewHelper';

export function createChatWebview(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'testdriverChat',
    'TestDriver Chat',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionUri.fsPath, 'media'))]
    }
  );

  // Create webview helper
  const helper = new WebviewHelper({
    extensionUri: context.extensionUri,
    webview: panel.webview,
    title: 'TestDriver Chat',
    isFullPanel: true
  });

  // Set panel icon
  const iconUri = helper.getIconUri();
  panel.iconPath = {
    light: iconUri,
    dark: iconUri
  };

  // Generate HTML using helper
  panel.webview.html = helper.generateHtml();

  return panel;
}


