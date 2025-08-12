import * as vscode from 'vscode';
import * as path from 'path';

export function createChatWebview(_context: vscode.ExtensionContext): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'testdriverChat',
    'TestDriver Chat',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(__dirname, '..', '..', 'media'))]
    }
  );

  const iconPath = vscode.Uri.file(path.join(__dirname, '..', '..', 'media', 'icon.png'));

  panel.iconPath = {
    light: iconPath,
    dark: iconPath
  };

  // Get the local path for media resources
  const mediaPath = vscode.Uri.file(path.join(__dirname, '..', '..', 'media'));
  const mediaSrc = panel.webview.asWebviewUri(mediaPath);

  panel.webview.html = getChatHtml(mediaSrc);

  return panel;
}

function getChatHtml(mediaSrc: vscode.Uri): string {
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
          background-color: var(--vscode-editor-background);
          color: var(--vscode-editor-foreground);
          height: 100vh;
          display: flex;
          flex-direction: column;
        }

        .header {
          display: flex;
          align-items: center;
          padding: 16px;
          background-color: var(--vscode-sideBar-background);
          border-bottom: 1px solid var(--vscode-sideBar-border);
        }

        .helmet-icon {
          width: 32px;
          height: 32px;
          margin-right: 12px;
          border-radius: 4px;
        }

        .title {
          font-size: 18px;
          font-weight: 600;
          color: var(--vscode-sideBar-foreground);
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
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .message {
          display: flex;
          align-items: flex-start;
          gap: 12px;
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
          width: 24px;
          height: 24px;
          border-radius: 12px;
          background-color: var(--vscode-badge-background);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          margin-top: 4px;
        }

        .message.user .message-avatar {
          background-color: var(--vscode-button-background);
        }

        .message-content {
          background-color: var(--vscode-input-background);
          border: 1px solid var(--vscode-input-border);
          border-radius: 8px;
          padding: 12px;
          max-width: 70%;
          word-wrap: break-word;
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
          border-radius: 4px;
          padding: 12px;
          margin: 8px 0;
          font-family: 'Courier New', monospace;
          font-size: 14px;
          overflow-x: auto;
          white-space: pre-wrap;
        }

        .input-container {
          padding: 16px;
          background-color: var(--vscode-sideBar-background);
          border-top: 1px solid var(--vscode-sideBar-border);
          display: flex;
          gap: 8px;
          align-items: end;
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
          padding: 12px;
          font-family: inherit;
          font-size: 14px;
          resize: vertical;
          min-height: 44px;
          max-height: 120px;
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
          padding: 12px 16px;
          cursor: pointer;
          font-family: inherit;
          font-size: 14px;
          min-width: 60px;
          height: 44px;
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
        }

        .empty-state .helmet-large {
          width: 64px;
          height: 64px;
          margin-bottom: 16px;
          opacity: 0.6;
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

        /* ANSI color support */
        .ansi-bright-black { color: #555; }
        .ansi-bright-red { color: #ff5555; }
        .ansi-bright-green { color: #55ff55; }
        .ansi-bright-yellow { color: #ffff55; }
        .ansi-bright-blue { color: #5555ff; }
        .ansi-bright-magenta { color: #ff55ff; }
        .ansi-bright-cyan { color: #55ffff; }
        .ansi-bright-white { color: #ffffff; }
        .ansi-black { color: #000; }
        .ansi-red { color: #aa0000; }
        .ansi-green { color: #00aa00; }
        .ansi-yellow { color: #aa5500; }
        .ansi-blue { color: #0000aa; }
        .ansi-magenta { color: #aa00aa; }
        .ansi-cyan { color: #00aaaa; }
        .ansi-white { color: #aaaaaa; }
        .ansi-bg-black { background-color: #000; }
        .ansi-bg-red { background-color: #aa0000; }
        .ansi-bg-green { background-color: #00aa00; }
        .ansi-bg-yellow { background-color: #aa5500; }
        .ansi-bg-blue { background-color: #0000aa; }
        .ansi-bg-magenta { background-color: #aa00aa; }
        .ansi-bg-cyan { background-color: #00aaaa; }
        .ansi-bg-white { background-color: #aaaaaa; }
        .ansi-bold { font-weight: bold; }
        .ansi-dim { opacity: 0.5; }
        .ansi-italic { font-style: italic; }
        .ansi-underline { text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="header">
        <img src="${mediaSrc}/icon.png" alt="TestDriver" class="helmet-icon" />
        <div class="title">TestDriver Chat</div>
      </div>

      <div class="chat-container">
        <div class="messages" id="messages">
          <div class="empty-state" id="emptyState">
            <img src="${mediaSrc}/icon.png" alt="TestDriver" class="helmet-large" />
            <h3>Welcome to TestDriver Chat</h3>
            <p>Start a conversation with TestDriver to automate your testing and QA tasks.</p>
            <div class="example-prompts">
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

      <script>
        const vscode = acquireVsCodeApi();

        const messagesContainer = document.getElementById('messages');
        const chatInput = document.getElementById('chatInput');
        const sendButton = document.getElementById('sendButton');
        const emptyState = document.getElementById('emptyState');

        let isRunning = false;

        function hideEmptyState() {
          if (emptyState) {
            emptyState.style.display = 'none';
          }
        }

        function addMessage(content, type = 'assistant', avatar = '🤖') {
          hideEmptyState();

          const messageDiv = document.createElement('div');
          messageDiv.className = \`message \${type}\`;

          const avatarDiv = document.createElement('div');
          avatarDiv.className = 'message-avatar';
          avatarDiv.textContent = type === 'user' ? '👤' : avatar;

          const contentDiv = document.createElement('div');
          contentDiv.className = 'message-content';

          if (type === 'code') {
            const codeBlock = document.createElement('div');
            codeBlock.className = 'code-block';
            codeBlock.innerHTML = content; // Use innerHTML to render HTML/ANSI
            contentDiv.appendChild(codeBlock);
          } else {
            contentDiv.innerHTML = content; // Use innerHTML to render HTML/ANSI
          }

          messageDiv.appendChild(avatarDiv);
          messageDiv.appendChild(contentDiv);

          messagesContainer.appendChild(messageDiv);
          messagesContainer.scrollTop = messagesContainer.scrollHeight;

          return messageDiv;
        }

        function updateMessage(messageDiv, content, type = 'assistant') {
          const contentDiv = messageDiv.querySelector('.message-content');

          if (type === 'code') {
            contentDiv.innerHTML = '';
            const codeBlock = document.createElement('div');
            codeBlock.className = 'code-block';
            codeBlock.innerHTML = content; // Use innerHTML to render HTML/ANSI
            contentDiv.appendChild(codeBlock);
          } else {
            contentDiv.innerHTML = content; // Use innerHTML to render HTML/ANSI
          }

          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function sendMessage() {
          const message = chatInput.value.trim();
          if (!message || isRunning) return;

          addMessage(message, 'user');
          chatInput.value = '';
          isRunning = true;
          sendButton.disabled = true;
          sendButton.textContent = 'Running...';

          vscode.postMessage({
            command: 'sendMessage',
            message: message
          });
        }

        function useExample(prompt) {
          chatInput.value = prompt;
          sendMessage();
        }

        sendButton.addEventListener('click', sendMessage);

        chatInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
          }
        });

        chatInput.addEventListener('input', () => {
          chatInput.style.height = 'auto';
          chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        });

        // Handle messages from the extension
        window.addEventListener('message', event => {
          const message = event.data;

          switch (message.command) {
            case 'chatResponse':
              isRunning = false;
              sendButton.disabled = false;
              sendButton.textContent = 'Send';
              break;

            case 'status':
              addMessage(message.data, 'status', '⏳');
              break;

            case 'log':
              addMessage(message.data, 'assistant', '🤖');
              break;

            case 'markdown':
              addMessage(message.data, 'code', '📝');
              break;

            case 'error':
              addMessage(message.data, 'error', '❌');
              isRunning = false;
              sendButton.disabled = false;
              sendButton.textContent = 'Send';
              break;
          }
        });

        // Focus input on load
        chatInput.focus();
      </script>
    </body>
    </html>
  `;
}
