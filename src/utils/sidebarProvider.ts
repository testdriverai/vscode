import * as vscode from 'vscode';

export class TestDriverSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'testdriver-sidebar';

  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri
      ]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'sendMessage': {
          const chatModule = await import('../commands/chat.js');
          await chatModule.handleChatMessage(message.message, webviewView, this._context);
          break;
        }
      }
    });
  }

  public postMessage(message: { command: string; data: string }) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // Get the local path for media resources
    const mediaPath = vscode.Uri.file(this._extensionUri.fsPath + '/media');
    const mediaSrc = webview.asWebviewUri(mediaPath);

    // Get the webview JavaScript file
    const webviewJsPath = vscode.Uri.file(this._extensionUri.fsPath + '/media/webview.js');
    const webviewJsSrc = webview.asWebviewUri(webviewJsPath);

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TestDriver Chat</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
            background-color: var(--vscode-sideBar-background);
            color: var(--vscode-sideBar-foreground);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }

          .header {
            display: flex;
            align-items: center;
            padding: 12px;
            background-color: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-sideBar-border);
            flex-shrink: 0;
          }

          .helmet-icon {
            width: 20px;
            height: 20px;
            margin-right: 8px;
            border-radius: 2px;
          }

          .title {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-sideBarSectionHeader-foreground);
          }

          .chat-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }

          .messages {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden; /* Prevent horizontal scrolling */
            padding: 8px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            word-wrap: break-word; /* Break long words */
            word-break: break-word; /* Break long words */
          }

          .message {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            font-size: 12px;
          }

          .message.user {
            flex-direction: row-reverse;
          }

          .message.user .message-content {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            margin-left: auto;
          }

          .message-avatar {
            width: 16px;
            height: 16px;
            border-radius: 8px;
            background-color: var(--vscode-badge-background);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            margin-top: 2px;
            font-size: 8px;
            overflow: hidden;
          }

          .message-avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }

          .message.user .message-avatar {
            background-color: var(--vscode-button-background);
          }

          .message-content {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 8px;
            max-width: calc(100% - 24px);
            word-wrap: break-word;
            overflow-wrap: break-word; /* Better word breaking */
            font-size: 11px;
            line-height: 1.4;
            min-width: 0; /* Allow content to shrink */
          }

          .message.status .message-content {
            background-color: var(--vscode-notifications-background);
            border-color: var(--vscode-notifications-border);
            font-style: italic;
          }

          .message.loading .message-content {
            background-color: var(--vscode-progressBar-background);
            animation: pulse 1.5s infinite;
          }

          @keyframes pulse {
            0%, 100% { opacity: 0.6; }
            50% { opacity: 1; }
          }

          .code-block {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-textBlockQuote-border);
            border-radius: 3px;
            padding: 6px;
            margin: 4px 0;
            font-family: var(--vscode-editor-font-family), 'Courier New', monospace;
            font-size: 10px;
            overflow-x: auto;
            overflow-y: hidden;
            white-space: pre;
            max-width: 100%;
            word-wrap: normal; /* Don't break words in code */
          }

          .code-block.yaml {
            border-left: 3px solid var(--vscode-textLink-foreground);
            background-color: var(--vscode-textBlockQuote-background);
          }

          .code-block code {
            background: none !important;
            border: none !important;
            padding: 0 !important;
            margin: 0 !important;
            font-family: inherit !important;
            color: var(--vscode-editor-foreground) !important;
            white-space: pre;
            overflow-wrap: normal;
          }

          .inline-code {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-textBlockQuote-border);
            border-radius: 2px;
            padding: 1px 3px;
            font-family: var(--vscode-editor-font-family), 'Courier New', monospace;
            font-size: 10px;
            color: var(--vscode-textPreformat-foreground);
          }

          .input-container {
            padding: 8px;
            background-color: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-sideBar-border);
            display: flex;
            flex-direction: column;
            gap: 6px;
            flex-shrink: 0;
          }

          .chat-input {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            padding: 6px;
            font-family: inherit;
            font-size: 11px;
            resize: vertical;
            min-height: 32px;
            max-height: 80px;
            width: 100%;
          }

          .chat-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
          }

          .send-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            padding: 6px 12px;
            cursor: pointer;
            font-family: inherit;
            font-size: 11px;
            width: 100%;
            height: 28px;
          }

          .send-button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }

          .send-button:disabled {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            cursor: not-allowed;
          }

          .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            padding: 16px;
          }

          .empty-state .helmet-large {
            width: 32px;
            height: 32px;
            margin-bottom: 12px;
            opacity: 0.6;
          }

          .empty-state h3 {
            font-size: 14px;
            margin-bottom: 8px;
          }

          .empty-state p {
            font-size: 11px;
            line-height: 1.4;
            margin-bottom: 12px;
          }

          .example-prompts {
            display: flex;
            flex-direction: column;
            gap: 4px;
            width: 100%;
          }

          .example-prompt {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 3px;
            padding: 4px 6px;
            cursor: pointer;
            font-family: inherit;
            font-size: 10px;
            text-align: left;
            line-height: 1.3;
          }

          .example-prompt:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
          }

          /* ANSI color support - VS Code theme compatible */
          .ansi-bright-black { color: var(--vscode-terminal-ansiBlack, #666666); }
          .ansi-bright-red { color: var(--vscode-terminal-ansiRed, #f14c4c); }
          .ansi-bright-green { color: var(--vscode-terminal-ansiGreen, #23d18b); }
          .ansi-bright-yellow { color: var(--vscode-terminal-ansiYellow, #f5f543); }
          .ansi-bright-blue { color: var(--vscode-terminal-ansiBlue, #3b8eea); }
          .ansi-bright-magenta { color: var(--vscode-terminal-ansiMagenta, #d670d6); }
          .ansi-bright-cyan { color: var(--vscode-terminal-ansiCyan, #29b8db); }
          .ansi-bright-white { color: var(--vscode-terminal-ansiWhite, #ffffff); }
          .ansi-black { color: var(--vscode-terminal-ansiBlack, #000000); }
          .ansi-red { color: var(--vscode-terminal-ansiRed, #cd3131); }
          .ansi-green { color: var(--vscode-terminal-ansiGreen, #0dbc79); }
          .ansi-yellow { color: var(--vscode-terminal-ansiYellow, #e5e510); }
          .ansi-blue { color: var(--vscode-terminal-ansiBlue, #2472c8); }
          .ansi-magenta { color: var(--vscode-terminal-ansiMagenta, #bc3fbc); }
          .ansi-cyan { color: var(--vscode-terminal-ansiCyan, #11a8cd); }
          .ansi-white { color: var(--vscode-terminal-ansiWhite, #e5e5e5); }
          .ansi-bg-black { background-color: var(--vscode-terminal-ansiBlack, #000000); }
          .ansi-bg-red { background-color: var(--vscode-terminal-ansiRed, #cd3131); }
          .ansi-bg-green { background-color: var(--vscode-terminal-ansiGreen, #0dbc79); }
          .ansi-bg-yellow { background-color: var(--vscode-terminal-ansiYellow, #e5e510); }
          .ansi-bg-blue { background-color: var(--vscode-terminal-ansiBlue, #2472c8); }
          .ansi-bg-magenta { background-color: var(--vscode-terminal-ansiMagenta, #bc3fbc); }
          .ansi-bg-cyan { background-color: var(--vscode-terminal-ansiCyan, #11a8cd); }
          .ansi-bg-white { background-color: var(--vscode-terminal-ansiWhite, #e5e5e5); }
          .ansi-bold { font-weight: bold; }
          .ansi-dim { opacity: 0.5; }
          .ansi-italic { font-style: italic; }
          .ansi-underline { text-decoration: underline; }

          /* Scrollbar styling to prevent horizontal overflow */
          .messages::-webkit-scrollbar {
            width: 8px;
          }

          .messages::-webkit-scrollbar-track {
            background: var(--vscode-scrollbarSlider-background);
          }

          .messages::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 4px;
          }

          .messages::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
          }

          /* Ensure text doesn't overflow horizontally */
          * {
            box-sizing: border-box;
          }

          pre, code {
            max-width: 100%;
            overflow-x: auto;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <img src="${mediaSrc}/icon.png" alt="TestDriver" class="helmet-icon" />
          <div class="title">TestDriver</div>
        </div>

        <div class="chat-container">
          <div class="messages" id="messages">
            <div class="empty-state" id="emptyState">
              <img src="${mediaSrc}/icon.png" alt="TestDriver" class="helmet-large" />
              <h3>TestDriver Chat</h3>
              <p>Ask TestDriver to help with testing and automation tasks.</p>
              <div class="example-prompts">
                <button class="example-prompt" onclick="useExample('Test the login flow')">
                  Test the login flow
                </button>
                <button class="example-prompt" onclick="useExample('Create a test for the shopping cart')">
                  Create a test for the shopping cart
                </button>
                <button class="example-prompt" onclick="useExample('Help me debug this test')">
                  Help me debug this test
                </button>
              </div>
            </div>
          </div>

          <div class="input-container">
            <textarea
              id="chatInput"
              class="chat-input"
              placeholder="Ask TestDriver..."
              rows="1"
            ></textarea>
            <button id="sendButton" class="send-button">Send</button>
          </div>
        </div>

        <script>
          // Set up global variables for the webview
          window.mediaSrc = '${mediaSrc}';
        </script>
        <script src="${webviewJsSrc}"></script>
      </body>
      </html>
    `;
  }
}
