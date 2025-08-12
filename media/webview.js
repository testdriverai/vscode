// TestDriver Webview JavaScript
class TestDriverWebview {
  constructor() {
    this.vscode = acquireVsCodeApi();
    this.messagesContainer = document.getElementById('messages');
    this.chatInput = document.getElementById('chatInput');
    this.sendButton = document.getElementById('sendButton');
    this.emptyState = document.getElementById('emptyState');
    this.isRunning = false;
    this.streamingMessages = new Map();

    this.init();
  }

  init() {
    this.setupEventListeners();
    this.focusInput();
  }

  setupEventListeners() {
    this.sendButton.addEventListener('click', () => this.sendMessage());

    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.chatInput.addEventListener('input', () => {
      this.chatInput.style.height = 'auto';
      this.chatInput.style.height = Math.min(this.chatInput.scrollHeight, 80) + 'px';
    });

    // Handle messages from the extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      console.log('Received message:', message);

      switch (message.command) {
        case 'agentEvent':
          this.handleAgentEvent(message.eventName, message.data);
          break;
        case 'chatResponse':
          this.isRunning = false;
          this.sendButton.disabled = false;
          this.sendButton.textContent = 'Send';
          break;
        case 'error':
          this.addMessage(message.data, 'error', '❌');
          this.isRunning = false;
          this.sendButton.disabled = false;
          this.sendButton.textContent = 'Send';
          break;
      }
    });
  }

  hideEmptyState() {
    if (this.emptyState) {
      this.emptyState.style.display = 'none';
    }
  }

  addMessage(content, type = 'assistant', _avatar = '🤖') {
    this.hideEmptyState();

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar';

    if (type === 'user') {
      avatarDiv.textContent = '👤';
    } else {
      // Use TestDriver icon for assistant messages
      const avatarImg = document.createElement('img');
      avatarImg.src = window.mediaSrc + '/icon.png';
      avatarImg.alt = 'TestDriver';
      avatarDiv.appendChild(avatarImg);
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    if (type === 'code') {
      const codeBlock = document.createElement('div');
      codeBlock.className = 'code-block';
      codeBlock.innerHTML = content;
      contentDiv.appendChild(codeBlock);
    } else {
      contentDiv.innerHTML = content;
    }

    messageDiv.appendChild(avatarDiv);
    messageDiv.appendChild(contentDiv);

    this.messagesContainer.appendChild(messageDiv);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

    return messageDiv;
  }

  sendMessage() {
    const message = this.chatInput.value.trim();
    if (!message || this.isRunning) {
      return;
    }

    this.addMessage(message, 'user');
    this.chatInput.value = '';
    this.isRunning = true;
    this.sendButton.disabled = true;
    this.sendButton.textContent = 'Running...';

    this.vscode.postMessage({
      command: 'sendMessage',
      message: message
    });
  }

  useExample(prompt) {
    this.chatInput.value = prompt;
    this.sendMessage();
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  processMarkdown(text) {
    // Convert code blocks to syntax highlighted YAML blocks
    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, language, code) => {
      // Default to yaml if no language specified or if it's yaml/yml
      const lang = language && language.toLowerCase();
      const isYaml = !lang || lang === 'yaml' || lang === 'yml';

      if (isYaml) {
        return '<pre class="code-block yaml"><code class="language-yaml">' +
               this.escapeHtml(code.trim()) + '</code></pre>';
      } else {
        return '<pre class="code-block"><code class="language-' + lang + '">' +
               this.escapeHtml(code.trim()) + '</code></pre>';
      }
    });

    // Convert inline code
    text = text.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Convert headers
    text = text.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    text = text.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    text = text.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Convert bold and italic
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');

    // Convert line breaks
    text = text.replace(/\n/g, '<br>');

    return text;
  }

  handleAgentEvent(eventName, data) {
    console.log('Handling agent event:', eventName, data);

    // Extract the first argument as the main data
    const mainData = data && data.length > 0 ? data[0] : '';

    switch (eventName) {
      case 'status':
        this.addMessage(String(mainData), 'status', '⏳');
        break;

      case 'log:log':
      case 'log:info':
      case 'log:warn':
        if (eventName !== 'log:debug') { // Skip debug messages
          let message = String(mainData);
          if (typeof mainData === 'object') {
            message = JSON.stringify(mainData, null, 2);
          }
          this.addMessage(message, 'assistant', '🤖');
        }
        break;

      case 'log:markdown:static':
        // Handle complete markdown blocks - process with enhanced markdown
        this.addMessage(this.processMarkdown(String(mainData)), 'code', '📝');
        break;

      case 'log:markdown:start': {
        // Start streaming markdown
        const streamId = mainData;
        this.streamingMessages.set(streamId, {
          element: null,
          buffer: ''
        });
        break;
      }

      case 'log:markdown:chunk':
        // Handle streaming markdown chunks
        if (data.length >= 2) {
          const chunkStreamId = data[0];
          const chunk = data[1];
          this.updateStreamingMarkdown(chunkStreamId, chunk);
        }
        break;

      case 'log:markdown:end': {
        // Finalize streaming markdown
        const endStreamId = mainData;
        this.finalizeStreamingMarkdown(endStreamId);
        break;
      }

      case 'error:general':
      case 'error:fatal':
      case 'error:sdk':
      case 'error:sandbox':
        this.addMessage(String(mainData), 'error', '❌');
        break;

      default:
        // For any other events, log them for debugging
        console.log('Unhandled agent event:', eventName, data);
        break;
    }
  }

  updateStreamingMarkdown(streamId, chunk) {
    let stream = this.streamingMessages.get(streamId);
    if (!stream) {
      stream = { element: null, buffer: '' };
      this.streamingMessages.set(streamId, stream);
    }

    stream.buffer += chunk;

    if (!stream.element) {
      // Create new streaming message
      stream.element = document.createElement('div');
      stream.element.className = 'message code';
      stream.element.innerHTML = `
        <div class="message-avatar">
          <img src="${window.mediaSrc}/icon.png" alt="TestDriver" />
        </div>
        <div class="message-content">
          <div class="streaming-content">${this.processMarkdown(stream.buffer)}</div>
        </div>
      `;
      this.messagesContainer.appendChild(stream.element);
    } else {
      // Update existing streaming message with processed markdown
      const contentElement = stream.element.querySelector('.streaming-content');
      if (contentElement) {
        contentElement.innerHTML = this.processMarkdown(stream.buffer);
      }
    }

    // Auto-scroll to bottom
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  finalizeStreamingMarkdown(streamId) {
    const stream = this.streamingMessages.get(streamId);
    if (stream) {
      this.streamingMessages.delete(streamId);
    }
  }

  focusInput() {
    this.chatInput.focus();
  }
}

// Global function for example prompts
function useExample(prompt) {
  if (window.testDriverWebview) {
    window.testDriverWebview.useExample(prompt);
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.testDriverWebview = new TestDriverWebview();
});
