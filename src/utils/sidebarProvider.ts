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

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>TestDriver Chat</title>
        <script src="https://cdn.jsdelivr.net/npm/ansi-to-html@0.7.2/lib/ansi_to_html.js"></script>
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

            if (type === 'user') {
              avatarDiv.textContent = '👤';
            } else {
              // Use TestDriver icon for assistant messages
              const avatarImg = document.createElement('img');
              avatarImg.src = '${mediaSrc}/icon.png';
              avatarImg.alt = 'TestDriver';
              avatarDiv.appendChild(avatarImg);
            }

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
            chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
          });

          // Handle messages from the extension
          window.addEventListener('message', event => {
            const message = event.data;

            // Debug logging
            console.log('Received message:', message);

            switch (message.command) {
              case 'agentEvent':
                // Handle unified agent events
                handleAgentEvent(message.eventName, message.data);
                break;

              case 'chatResponse':
                isRunning = false;
                sendButton.disabled = false;
                sendButton.textContent = 'Send';
                break;

              case 'error':
                addMessage(message.data, 'error', '❌');
                isRunning = false;
                sendButton.disabled = false;
                sendButton.textContent = 'Send';
                break;
            }
          });

          // Initialize ANSI to HTML converter
          let ansiConverter;
          try {
            ansiConverter = new AnsiToHtml({
              fg: '#cccccc',
              bg: 'transparent',
              newline: false,
              escapeXML: false,
              stream: false,
              colors: {
                0: '#000000',   // black
                1: '#cd3131',   // red
                2: '#0dbc79',   // green
                3: '#e5e510',   // yellow
                4: '#2472c8',   // blue
                5: '#bc3fbc',   // magenta
                6: '#11a8cd',   // cyan
                7: '#e5e5e5',   // white
                8: '#666666',   // bright black (gray)
                9: '#f14c4c',   // bright red
                10: '#23d18b',  // bright green
                11: '#f5f543',  // bright yellow
                12: '#3b8eea',  // bright blue
                13: '#d670d6',  // bright magenta
                14: '#29b8db',  // bright cyan
                15: '#ffffff'   // bright white
              }
            });
          } catch (e) {
            console.warn('AnsiToHtml not available, using fallback');
            ansiConverter = null;
          }

          function convertAnsiToHtml(text) {
            if (ansiConverter) {
              try {
                const result = ansiConverter.toHtml(text);
                console.log('ANSI conversion:', { input: text, output: result });
                return result;
              } catch (e) {
                console.warn('ANSI conversion failed:', e);
                return text.replace(/\u001b\[[0-9;]*m/g, '');
              }
            }
            // Fallback: simple ANSI color removal
            return text.replace(/\u001b\[[0-9;]*m/g, '');
          }

          // HTML escape function
          function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }

          // Enhanced markdown processing function
          function processMarkdown(text) {
            // Convert code blocks to syntax highlighted YAML blocks
            text = text.replace(/\`\`\`(\\w+)?\\n([\\s\\S]*?)\`\`\`/g, function(match, language, code) {
              // Default to yaml if no language specified or if it's yaml/yml
              const lang = language && language.toLowerCase();
              const isYaml = !lang || lang === 'yaml' || lang === 'yml';

              if (isYaml) {
                return '<pre class="code-block yaml"><code class="language-yaml">' +
                       escapeHtml(code.trim()) + '</code></pre>';
              } else {
                return '<pre class="code-block"><code class="language-' + lang + '">' +
                       escapeHtml(code.trim()) + '</code></pre>';
              }
            });

            // Convert inline code
            text = text.replace(/\`([^\`]+)\`/g, '<code class="inline-code">$1</code>');

            // Convert headers
            text = text.replace(/^### (.*$)/gim, '<h3>$1</h3>');
            text = text.replace(/^## (.*$)/gim, '<h2>$1</h2>');
            text = text.replace(/^# (.*$)/gim, '<h1>$1</h1>');

            // Convert bold and italic
            text = text.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
            text = text.replace(/\\*(.*?)\\*/g, '<em>$1</em>');

            // Convert line breaks
            text = text.replace(/\\n/g, '<br>');

            return text;
          }

          // Map to track streaming messages
          const streamingMessages = new Map();

          // Handle different types of agent events
          function handleAgentEvent(eventName, data) {
            console.log('Handling agent event:', eventName, data);

            // Extract the first argument as the main data
            const mainData = data && data.length > 0 ? data[0] : '';

            switch (eventName) {
              case 'status':
                addMessage(convertAnsiToHtml(String(mainData)), 'status', '⏳');
                break;

              case 'log:log':
              case 'log:info':
              case 'log:warn':
                if (eventName !== 'log:debug') { // Skip debug messages
                  let message = String(mainData);
                  if (typeof mainData === 'object') {
                    message = JSON.stringify(mainData, null, 2);
                  }
                  addMessage(convertAnsiToHtml(message), 'assistant', '🤖');
                }
                break;

              case 'log:markdown:static':
                // Handle complete markdown blocks - process with enhanced markdown
                addMessage(processMarkdown(String(mainData)), 'code', '📝');
                break;

              case 'log:markdown:start':
                // Start streaming markdown
                const streamId = mainData;
                streamingMessages.set(streamId, {
                  element: null,
                  buffer: ''
                });
                break;

              case 'log:markdown:chunk':
                // Handle streaming markdown chunks
                if (data.length >= 2) {
                  const chunkStreamId = data[0];
                  const chunk = data[1];
                  updateStreamingMarkdown(chunkStreamId, chunk);
                }
                break;

              case 'log:markdown:end':
                // Finalize streaming markdown
                const endStreamId = mainData;
                finalizeStreamingMarkdown(endStreamId);
                break;

              case 'error:general':
              case 'error:fatal':
              case 'error:sdk':
              case 'error:sandbox':
                addMessage(convertAnsiToHtml(String(mainData)), 'error', '❌');
                break;

              default:
                // For any other events, log them for debugging
                console.log('Unhandled agent event:', eventName, data);
                break;
            }
          }

          function updateStreamingMarkdown(streamId, chunk) {
            let stream = streamingMessages.get(streamId);
            if (!stream) {
              stream = { element: null, buffer: '' };
              streamingMessages.set(streamId, stream);
            }

            stream.buffer += chunk;

            if (!stream.element) {
              // Create new streaming message
              stream.element = document.createElement('div');
              stream.element.className = 'message code';
              stream.element.innerHTML = \`
                <div class="message-avatar">
                  <img src="${mediaSrc}/icon.png" alt="TestDriver" />
                </div>
                <div class="message-content">
                  <div class="streaming-content">\${processMarkdown(stream.buffer)}</div>
                </div>
              \`;
              messagesContainer.appendChild(stream.element);
            } else {
              // Update existing streaming message with processed markdown
              const contentElement = stream.element.querySelector('.streaming-content');
              if (contentElement) {
                contentElement.innerHTML = processMarkdown(stream.buffer);
              }
            }

            // Auto-scroll to bottom
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
          }

          function finalizeStreamingMarkdown(streamId) {
            const stream = streamingMessages.get(streamId);
            if (stream) {
              streamingMessages.delete(streamId);
            }
          }

          // Focus input on load
          chatInput.focus();
        </script>
      </body>
      </html>
    `;
  }
}
