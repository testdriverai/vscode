import * as vscode from 'vscode';
import * as path from 'path';

export interface WebviewConfig {
  extensionUri: vscode.Uri;
  webview: vscode.Webview;
  title?: string;
  isFullPanel?: boolean;
}

export class WebviewHelper {
  private readonly mediaUri: vscode.Uri;

  constructor(private config: WebviewConfig) {
    // Compute media URI once
    const mediaPath = vscode.Uri.file(path.join(config.extensionUri.fsPath, 'media'));
    this.mediaUri = config.webview.asWebviewUri(mediaPath);
  }

  public getMediaUri(): vscode.Uri {
    return this.mediaUri;
  }

  public getIconUri(): vscode.Uri {
    const iconPath = vscode.Uri.file(path.join(this.config.extensionUri.fsPath, 'media', 'icon.png'));
    return this.config.webview.asWebviewUri(iconPath);
  }

  public generateHtml(): string {
    const isPanel = this.config.isFullPanel ?? true;
    const styles = this.generateStyles(isPanel);
    const scripts = this.generateScripts();

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${this.config.title || 'TestDriver Chat'}</title>
        ${styles}
      </head>
      <body>
        ${this.generateBody(isPanel)}
        ${scripts}
      </body>
      </html>
    `;
  }

  private generateStyles(isPanel: boolean): string {
    const baseStyles = `
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
          background-color: var(--vscode-editor-background);
          color: var(--vscode-editor-foreground);
          height: 100vh;
          display: flex;
          flex-direction: column;
        }

        .header {
          display: flex;
          align-items: center;
          padding: ${isPanel ? '16px' : '8px'};
          background-color: var(--vscode-sideBar-background);
          border-bottom: 1px solid var(--vscode-sideBar-border);
        }

        .helmet-icon {
          width: ${isPanel ? '32px' : '24px'};
          height: ${isPanel ? '32px' : '24px'};
          margin-right: ${isPanel ? '12px' : '8px'};
          border-radius: 4px;
        }

        .title {
          font-size: ${isPanel ? '18px' : '14px'};
          font-weight: 600;
          color: var(--vscode-sideBar-foreground);
        }

        /* Chat styles */
        .chat-container {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .messages {
          flex: 1;
          overflow-y: auto;
          padding: ${isPanel ? '16px' : '8px'};
          display: flex;
          flex-direction: column;
          gap: ${isPanel ? '16px' : '8px'};
        }

        .message {
          display: flex;
          align-items: flex-start;
          gap: ${isPanel ? '12px' : '8px'};
          font-size: ${isPanel ? '14px' : '12px'};
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
          width: ${isPanel ? '24px' : '16px'};
          height: ${isPanel ? '24px' : '16px'};
          border-radius: ${isPanel ? '12px' : '8px'};
          background-color: var(--vscode-badge-background);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          margin-top: 4px;
        }

        .message-avatar img {
          width: 100%;
          height: 100%;
          border-radius: inherit;
        }

        .message-content {
          background-color: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border);
          border-radius: ${isPanel ? '8px' : '6px'};
          padding: ${isPanel ? '12px' : '8px'};
          max-width: ${isPanel ? '70%' : 'calc(100% - 24px)'};
          word-wrap: break-word;
          line-height: 1.4;
        }

        .message.status .message-content {
          background-color: var(--vscode-notifications-background);
          border-color: var(--vscode-notifications-border);
          font-style: italic;
        }

        .code-block {
          background-color: var(--vscode-textCodeBlock-background);
          border: 1px solid var(--vscode-textBlockQuote-border);
          border-radius: 4px;
          padding: ${isPanel ? '12px' : '6px'};
          margin: ${isPanel ? '8px 0' : '4px 0'};
          font-family: 'Courier New', monospace;
          font-size: ${isPanel ? '14px' : '10px'};
          overflow-x: auto;
          white-space: pre-wrap;
        }

        /* Input area */
        .input-container {
          padding: ${isPanel ? '16px' : '8px'};
          background-color: var(--vscode-sideBar-background);
          border-top: 1px solid var(--vscode-sideBar-border);
          display: flex;
          ${isPanel ? 'gap: 8px; align-items: end;' : 'flex-direction: column; gap: 6px;'}
          flex-shrink: 0;
        }

        .input-wrapper {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .chat-input {
          background-color: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
          border-radius: 4px;
          padding: ${isPanel ? '12px' : '6px'};
          font-family: inherit;
          font-size: ${isPanel ? '14px' : '11px'};
          resize: vertical;
          min-height: ${isPanel ? '44px' : '32px'};
          max-height: ${isPanel ? '120px' : '80px'};
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
          border-radius: 4px;
          padding: ${isPanel ? '12px 16px' : '6px 12px'};
          cursor: pointer;
          font-family: inherit;
          font-size: ${isPanel ? '14px' : '11px'};
          ${isPanel ? 'min-width: 60px; height: 44px;' : 'width: 100%; height: 28px;'}
        }

        .send-button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }

        .send-button:disabled {
          background-color: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          cursor: not-allowed;
        }

        /* Empty state */
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
          width: ${isPanel ? '64px' : '32px'};
          height: ${isPanel ? '64px' : '32px'};
          margin-bottom: ${isPanel ? '16px' : '12px'};
          opacity: 0.6;
        }

        .empty-state h3 {
          font-size: ${isPanel ? '16px' : '14px'};
          margin-bottom: 8px;
        }

        .example-prompts {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 16px;
        }

        .example-prompt {
          background-color: var(--vscode-button-secondaryBackground);
          color: var(--vscode-button-secondaryForeground);
          border: none;
          border-radius: 4px;
          padding: 8px 12px;
          cursor: pointer;
          font-family: inherit;
          font-size: 13px;
          text-align: left;
        }

        .example-prompt:hover {
          background-color: var(--vscode-button-secondaryHoverBackground);
        }
      </style>
    `;

    return baseStyles;
  }

  private generateBody(isPanel: boolean): string {
    return `
      <div class="header">
        <img src="${this.mediaUri}/icon.png" alt="TestDriver" class="helmet-icon" />
        <div class="title">${this.config.title || 'TestDriver Chat'}</div>
      </div>

      <div class="chat-container">
        <div class="messages" id="messages">
          <div class="empty-state" id="emptyState">
            <img src="${this.mediaUri}/icon.png" alt="TestDriver" class="helmet-large" />
            <h3>Welcome to TestDriver Chat</h3>
            <p>${isPanel ? 'Start a conversation with TestDriver to automate your testing and QA tasks.' : 'Ask TestDriver to help with testing and automation tasks.'}</p>
            <div class="example-prompts" id="examplePrompts">
              <button class="example-prompt" onclick="useExample('Test the login flow on my application')">
                Test the login flow on my application
              </button>
              <button class="example-prompt" onclick="useExample('Create a test for the shopping cart feature')">
                Create a test for the shopping cart feature
              </button>
              <button class="example-prompt" onclick="useExample('Help me debug this failing test')">
                Help me debug this failing test
              </button>
            </div>
          </div>
        </div>

        <div class="input-container">
          <div class="input-wrapper">
            <textarea
              id="chatInput"
              class="chat-input"
              placeholder="Type your message to TestDriver..."
              rows="1"
            ></textarea>
          </div>
          <button id="sendButton" class="send-button">Send</button>
        </div>
      </div>
    `;
  }

  private generateScripts(): string {
    return `
      <script>
        const vscode = acquireVsCodeApi();
        window.mediaSrc = "${this.mediaUri}";

        // Load external webview.js if available
        const script = document.createElement('script');
        script.src = "${this.mediaUri}/webview.js";
        script.onerror = function() {
          // Fallback to inline implementation
          ${this.getInlineScripts()}
        };
        document.head.appendChild(script);
      </script>
    `;
  }

  private getInlineScripts(): string {
    return `
      // Inline fallback implementation
      class SimpleWebview {
        constructor() {
          this.vscode = vscode;
          this.isRunning = false;
          this.init();
        }

        init() {
          const chatInput = document.getElementById('chatInput');
          const sendButton = document.getElementById('sendButton');

          sendButton.addEventListener('click', () => this.sendMessage());

          chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              this.sendMessage();
            }
          });

          window.addEventListener('message', (event) => {
            // Handle messages from extension
            console.log('Received message:', event.data);
          });

          chatInput.focus();
        }

        sendMessage() {
          const chatInput = document.getElementById('chatInput');
          const message = chatInput.value.trim();
          if (!message || this.isRunning) return;

          this.vscode.postMessage({
            command: 'sendMessage',
            message: message
          });

          chatInput.value = '';
        }
      }

      window.useExample = function(prompt) {
        document.getElementById('chatInput').value = prompt;
        window.webview.sendMessage();
      };

      document.addEventListener('DOMContentLoaded', () => {
        window.webview = new SimpleWebview();
      });
    `;
  }
}
