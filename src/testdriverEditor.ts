import * as vscode from 'vscode';
import * as path from 'path';

export class TestDriverCustomEditorProvider implements vscode.CustomTextEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new TestDriverCustomEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      'testdriver.yamlEditor',
      provider,
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'update': {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), message.text);
          await vscode.workspace.applyEdit(edit);
          break;
        }
        case 'ready': {
          webviewPanel.webview.postMessage({ type: 'init', text: document.getText() });
          break;
        }
      }
    });

    // Update webview when document changes
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        webviewPanel.webview.postMessage({ type: 'init', text: document.getText() });
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'testdriver-editor.js')));
    const styleUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'testdriver-editor.css')));
    const iconUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'icon.png')));
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TestDriver YAML Editor</title>
        <link rel="stylesheet" href="${styleUri}">
        <link rel="icon" type="image/png" href="${iconUri}">
      </head>
      <body>
        <img src="${iconUri}" alt="TestDriver Icon" style="width: 40px; height: 40px; display: block; margin: 16px auto;" />
        <div id="editor-root"></div>
        <script src="https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js"></script>
        <script src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }
}
