import * as vscode from 'vscode';
import * as path from 'path';

export function openTestDriverWebview(url: string, title = 'TestDriver') {
  const panel = vscode.window.createWebviewPanel(
    'testdriverWebview',
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(__dirname, '..', '..', 'media'))]
    }
  );

  // Get the URI for the icon
  const iconPath = vscode.Uri.file(path.join(__dirname, '..', '..', 'media', 'icon.png'));
  const iconUri = panel.webview.asWebviewUri(iconPath);

  // Simple HTML to embed the external URL in an iframe
  panel.webview.html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <link rel="icon" type="image/png" href="${iconUri}">
      <link rel="shortcut icon" type="image/png" href="${iconUri}">
      <style>
        html, body, iframe { height: 100%; width: 100%; margin: 0; padding: 0; border: none; }
        iframe { border: none; }
      </style>
    </head>
    <body>
      <iframe src="${url}" width="100%" height="100%" allowfullscreen></iframe>
    </body>
    </html>
  `;

  return panel;
}
