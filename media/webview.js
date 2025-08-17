// TestDriver Webview JavaScript
class TestDriverWebview {
  constructor() {
    this.vscode = acquireVsCodeApi();
    this.messagesContainer = document.getElementById('messages');
    this.chatInput = document.getElementById('chatInput');
    this.sendButton = document.getElementById('sendButton');
    this.runButton = document.getElementById('runButton'); // Keep for backward compatibility
    this.runButtonTop = document.getElementById('runButtonTop');
    this.emptyState = document.getElementById('emptyState');
    this.isRunning = false;
    this.streamingMessages = new Map();

    this.init();
  }

  init() {
    this.setupEventListeners();
    this.focusInput();
    
    // Wait for marked to be available before configuring
    this.waitForMarkedAndConfigure();

    // Signal that the webview is ready to receive messages
    this.vscode.postMessage({ command: 'webviewReady' });
  }

  waitForMarkedAndConfigure() {
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds max
    
    const checkAndConfigure = () => {
      attempts++;
      console.log(`Attempt ${attempts}: Checking for marked...`);
      
      if (typeof marked !== 'undefined') {
        console.log('Marked found, configuring...');
        this.configureMarked();
      } else if (attempts < maxAttempts) {
        console.log('Marked not ready yet, retrying...');
        setTimeout(checkAndConfigure, 100);
      } else {
        console.error('Marked failed to load after', maxAttempts, 'attempts');
      }
    };
    
    checkAndConfigure();
  }

  configureMarked() {
    // Configure marked once during initialization
    console.log('Configuring marked, available:', typeof marked !== 'undefined');
    if (typeof marked !== 'undefined') {
      const renderer = new marked.Renderer();

      // Override code block rendering to use YAML syntax highlighting
      renderer.code = function(code, language) {
        console.log('Rendering code block, language:', language, 'code:', code.substring(0, 50));
        // Default to yaml if no language specified or if it's yaml/yml
        const lang = language && language.toLowerCase();
        const isYaml = !lang || lang === 'yaml' || lang === 'yml';
        const finalLang = isYaml ? 'yaml' : lang;

        // Clean the code to preserve whitespace
        const cleanCode = code.replace(/^\n/, '').replace(/\n$/, '');

        console.log('Will render as YAML:', isYaml, 'final language:', finalLang);

        if (isYaml) {
          return '<pre class="code-block yaml"><code class="language-yaml">' +
            cleanCode + '</code></pre>';
        } else {
          return '<pre class="code-block"><code class="language-' + finalLang + '">' +
            cleanCode + '</code></pre>';
        }
      };

      // Override inline code rendering
      renderer.codespan = function(code) {
        return '<code class="inline-code">' + code + '</code>';
      };

      // Configure marked options
      marked.setOptions({
        renderer: renderer,
        breaks: true, // Convert \n to <br>
        gfm: true,    // GitHub Flavored Markdown
        sanitize: false
      });
      
      console.log('Marked configured successfully with custom renderer');
    } else {
      console.error('Cannot configure marked - library not available');
    }
  }

  setupEventListeners() {
    this.sendButton.addEventListener('click', () => {
      if (this.isRunning) {
        this.stopTest();
      } else {
        this.sendMessage();
      }
    });

    // Handle both old and new run buttons
    if (this.runButton) {
      this.runButton.addEventListener('click', () => {
        if (this.isRunning) {
          this.stopTest();
        } else {
          this.runTests();
        }
      });
    }
    if (this.runButtonTop) {
      this.runButtonTop.addEventListener('click', () => {
        if (this.isRunning) {
          this.stopTest();
        } else {
          this.runTests();
        }
      });
    }

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

    // File selector button
    const selectFileButton = document.getElementById('selectFileButton');
    if (selectFileButton) {
      selectFileButton.addEventListener('click', () => {
        this.selectFile();
      });
    }

    // File path click handler to open file
    const currentFileElement = document.getElementById('currentFile');
    if (currentFileElement) {
      currentFileElement.addEventListener('click', () => {
        this.openCurrentFile();
      });
    }

    // Handle messages from the extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      console.log('Received message:', message);

      switch (message.command) {
        case 'agentEvent':
          this.handleAgentEvent(message.eventName, message.data);
          break;
        case 'chatResponse':
          // Command completed, ready for next input (like readline promptUser)
          this.isRunning = false;
          this.sendButton.disabled = false;
          this.sendButton.textContent = 'Send';

          // Reset run button states as well
          if (this.runButton) {
            this.runButton.disabled = false;
            this.runButton.textContent = 'Run';
          }
          if (this.runButtonTop) {
            this.runButtonTop.disabled = false;
            this.runButtonTop.textContent = 'Run';
          }

          this.focusInput(); // Auto-focus for continuous interaction
          break;
        case 'testStopped':
          // Test was stopped by user
          this.addMessage('🛑 Test execution stopped', 'status', '🛑');
          this.isRunning = false;
          this.sendButton.disabled = false;
          this.sendButton.textContent = 'Send';

          // Reset run button states as well
          if (this.runButton) {
            this.runButton.disabled = false;
            this.runButton.textContent = 'Run';
          }
          if (this.runButtonTop) {
            this.runButtonTop.disabled = false;
            this.runButtonTop.textContent = 'Run';
          }

          this.focusInput();
          break;
        case 'showExamples':
          console.log('Webview received showExamples:', message.examples);
          this.showExamplesSelection(message.examples);
          break;
        case 'testFileInfo':
          // Update the running message to show which file is being tested
          this.addMessage(`🎯 Running test for: ${message.fileName}`, 'status', '🎯');
          break;
        case 'updateFileIndicator':
          this.updateFileIndicator(message.workspaceName, message.fileName);
          break;
        case 'clearChat':
          this.clearChat();
          break;
        case 'showRunButton':
          this.showRunButton();
          break;
        case 'hideRunButton':
          this.hideRunButton();
          break;
        case 'hideInputAndRunButton':
          this.hideInputAndRunButton();
          break;
        case 'showInputAndRunButton':
          this.showInputAndRunButton();
          break;
        case 'error':
          this.addMessage(message.data, 'error', '❌');
          this.isRunning = false;
          this.sendButton.disabled = false;
          this.sendButton.textContent = 'Send';

          // Reset run button states as well
          if (this.runButton) {
            this.runButton.disabled = false;
            this.runButton.textContent = 'Run';
          }
          if (this.runButtonTop) {
            this.runButtonTop.disabled = false;
            this.runButtonTop.textContent = 'Run';
          }

          this.focusInput(); // Auto-focus even after error
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
    } else if (type === 'error') {
      // Format error messages in monospace with proper formatting
      let formattedContent = content;

      // Try to detect and format JSON error messages
      try {
        // Check if content looks like JSON
        if (content.includes('{') && content.includes('}')) {
          // Extract and format JSON portions
          formattedContent = content.replace(/(\{[^}]*\})/g, (match) => {
            try {
              const parsed = JSON.parse(match);
              return JSON.stringify(parsed, null, 2);
            } catch {
              return match;
            }
          });
        }
      } catch (e) {
        // If formatting fails, use original content
        formattedContent = content;
      }

      // Escape HTML but preserve line breaks
      const div = document.createElement('div');
      div.textContent = formattedContent;
      const escapedContent = div.innerHTML.replace(/\n/g, '<br>');
      contentDiv.innerHTML = escapedContent;
    } else {
      contentDiv.innerHTML = content;
    }

    messageDiv.appendChild(avatarDiv);
    messageDiv.appendChild(contentDiv);

    this.messagesContainer.appendChild(messageDiv);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

    // Trigger syntax highlighting for any new code blocks
    this.highlightCodeBlocks();

    return messageDiv;
  }

  sendMessage() {
    const message = this.chatInput.value.trim();
    if (!message) {
      return;
    }

    this.addMessage(message, 'user');
    this.chatInput.value = '';
    this.isRunning = true;
    this.sendButton.disabled = false; // Keep button enabled for stopping
    this.sendButton.textContent = 'Stop';

    this.vscode.postMessage({
      command: 'sendMessage',
      message: message
    });
  }

  stopTest() {
    console.log('Stopping test execution...');

    // Stop any loading spinners immediately
    this.completeLoadingSpinner();

    this.addMessage('🛑 Stopping test execution...', 'status', '🛑');

    this.vscode.postMessage({
      command: 'stopTest'
    });
  }

  runTests() {
    if (this.isRunning) {
      return;
    }

    this.addMessage('🧪 Running TestDriver test for current file...', 'status', '🧪');
    this.isRunning = true;

    // Change button text to "Stop" but keep them enabled
    if (this.runButton) {
      this.runButton.disabled = false;
      this.runButton.textContent = 'Stop';
    }
    if (this.runButtonTop) {
      this.runButtonTop.disabled = false;
      this.runButtonTop.textContent = 'Stop';
    }

    this.vscode.postMessage({
      command: 'runTests'
    });

    // Reset button state after tests should have started
    setTimeout(() => {
      this.isRunning = false;
      if (this.runButton) {
        this.runButton.disabled = false;
        this.runButton.textContent = 'Run From Start';
      }
      if (this.runButtonTop) {
        this.runButtonTop.disabled = false;
        this.runButtonTop.textContent = 'Run From Start';
      }
      this.addMessage('Test execution started for the specific file. Check the Test Explorer for results.', 'status', '<span class="codicon codicon-check"></span>');
    }, 1500);
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
    console.log('Processing markdown:', text);
    console.log('Marked available:', typeof marked !== 'undefined');

    // Process the markdown using marked (configured during init)
    let processed;
    if (typeof marked !== 'undefined') {
      try {
        processed = marked.parse(text);
        console.log('Processed with marked:', processed.substring(0, 100));
      } catch (error) {
        console.error('Error processing with marked:', error);
        processed = text;
      }
    } else {
      console.log('Marked not available, using raw text');
      processed = text;
    }

    // Trigger Prism.js syntax highlighting after DOM update
    setTimeout(() => {
      if (window.Prism) {
        window.Prism.highlightAll();
      }
    }, 0);

    return processed;
  }

  highlightCodeBlocks() {
    // Use Prism.js to highlight all code blocks
    console.log('highlightCodeBlocks called, Prism available:', !!window.Prism);
    if (window.Prism && window.Prism.highlightAll) {
      // Small delay to ensure DOM is updated
      setTimeout(() => {
        console.log('Running Prism.highlightAll()');
        const codeBlocks = document.querySelectorAll('pre code');
        console.log('Found code blocks:', codeBlocks.length);
        codeBlocks.forEach((block, index) => {
          console.log(`Code block ${index}:`, block.className, block.textContent.substring(0, 50));
        });
        window.Prism.highlightAll();
      }, 0);
    } else {
      console.log('Prism not available for highlighting');
    }
  }

  handleAgentEvent(eventName, data) {
    console.log('Handling agent event:', eventName, data);

    // Extract the first argument as the main data
    const mainData = data && data.length > 0 ? data[0] : '';

    // Add checkmark to loading spinner when log or narration events come in
    if (eventName.startsWith('log:')) {
      this.completeLoadingSpinner();
    }

    console.log(eventName, mainData);

    switch (eventName) {
      case 'log:narration':
        this.showLoadingSpinner(String(mainData));
        break;
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

      case 'exit':
        // Agent has exited - complete any loading spinner and reset state
        this.completeLoadingSpinner();
        console.log('Agent exited with code:', mainData);
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

    // Trigger syntax highlighting for any new code blocks
    this.highlightCodeBlocks();
  }

  finalizeStreamingMarkdown(streamId) {
    const stream = this.streamingMessages.get(streamId);
    if (stream) {
      this.streamingMessages.delete(streamId);
      // Final syntax highlighting pass
      this.highlightCodeBlocks();
    }
  }

  showExamplesSelection(examples) {
    // Instead of hiding empty state and creating a message,
    // update the empty state to show examples
    const emptyState = document.getElementById('emptyState');
    if (emptyState) {
      emptyState.innerHTML = `
        <img src="${window.mediaSrc}/icon.png" alt="TestDriver" class="helmet-large" />
        <h3>No testdriver files found</h3>
        <p>Select an example to get started:</p>
        <div class="examples-grid">
          ${examples.map(example => `
            <button class="example-button" onclick="selectExample('${example.name}')">
              <div class="example-name">${example.displayName}</div>
            </button>
          `).join('')}
        </div>
        <p class="examples-note">This will create a testdriver folder and copy the selected example files to it.</p>
      `;
    }

    // Keep input enabled for selecting examples
    this.isRunning = false;
    this.sendButton.disabled = false;
    this.sendButton.textContent = 'Send';
  }

  updateEmptyStateExamples(examples) {
    console.log('updateEmptyStateExamples called with:', examples);
    const examplePrompts = document.getElementById('examplePrompts');
    const loadingExamples = document.getElementById('loadingExamples');

    if (loadingExamples) {
      loadingExamples.remove();
    }

    if (examplePrompts) {
      console.log('Updating empty state with', examples.length, 'examples');
      examplePrompts.innerHTML = `
        ${examples.map(example => `
          <button class="example-prompt" onclick="useExample('/copy-example ${example.name}')">
            /copy-example ${example.name}
          </button>
        `).join('')}
        <button class="example-prompt" onclick="useExample('/help')">
          /help
        </button>
      `;
    } else {
      console.log('Could not find examplePrompts element');
    }
  }

  updateFileIndicator(workspaceName, fileName) {
    const fileIndicator = document.getElementById('fileIndicator');
    const currentFileElement = document.getElementById('currentFile');

    if (fileIndicator && currentFileElement) {
      currentFileElement.textContent = fileName;
      // File indicator should always be visible now
      fileIndicator.style.display = 'block';
    }
  }

  showRunButton() {
    const runButtonTop = document.getElementById('runButtonTop');
    if (runButtonTop) {
      runButtonTop.style.display = 'block';
    }
  }

  hideRunButton() {
    const runButtonTop = document.getElementById('runButtonTop');
    if (runButtonTop) {
      runButtonTop.style.display = 'none';
    }
  }

  hideInputAndRunButton() {
    const inputContainer = document.querySelector('.input-container');
    if (inputContainer) {
      inputContainer.style.display = 'none';
    }
  }

  showInputAndRunButton() {
    const inputContainer = document.querySelector('.input-container');
    if (inputContainer) {
      inputContainer.style.display = 'flex';
    }
  }

  focusInput() {
    this.chatInput.focus();
  }

  showLoadingSpinner(message) {
    this.hideEmptyState();

    // Complete any existing loading spinner before creating a new one
    this.completeLoadingSpinner();

    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'message assistant loading-message';
    loadingDiv.id = 'loadingSpinner';

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar';
    const avatarImg = document.createElement('img');
    avatarImg.src = window.mediaSrc + '/icon.png';
    avatarImg.alt = 'TestDriver';
    avatarDiv.appendChild(avatarImg);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = `
      <div class="loading-content">
        <span class="codicon codicon-loading codicon-modifier-spin"></span>
        <span class="loading-text">${message}</span>
      </div>
    `;

    loadingDiv.appendChild(avatarDiv);
    loadingDiv.appendChild(contentDiv);

    this.messagesContainer.appendChild(loadingDiv);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  removeLoadingSpinner() {
    const existingSpinner = document.getElementById('loadingSpinner');
    if (existingSpinner) {
      existingSpinner.remove();
    }
  }

  completeLoadingSpinner() {
    const existingSpinner = document.getElementById('loadingSpinner');
    if (existingSpinner) {
      // Replace the spinner with a checkmark icon
      const spinnerElement = existingSpinner.querySelector('.codicon-loading');
      if (spinnerElement) {
        spinnerElement.className = 'codicon codicon-check';
      }

      // Remove the ID so new spinners can use it
      existingSpinner.removeAttribute('id');

      // Optionally fade out the completed message after a short delay
      setTimeout(() => {
        if (existingSpinner.parentNode) {
          existingSpinner.style.opacity = '0.7';
        }
      }, 1000);
    }
  }

  selectFile() {
    this.vscode.postMessage({
      command: 'selectFile'
    });
  }

  openCurrentFile() {
    this.vscode.postMessage({
      command: 'openCurrentFile'
    });
  }

  clearChat() {
    // Clear all messages except the empty state
    this.messagesContainer.innerHTML = '';

    // Restore empty state
    this.messagesContainer.appendChild(this.emptyState);
    this.emptyState.style.display = 'flex';

    // Reset running state
    this.isRunning = false;
    this.sendButton.disabled = false;
    this.sendButton.textContent = 'Generate Test Steps';

    if (this.runButton) {
      this.runButton.disabled = false;
      this.runButton.textContent = 'Run';
    }
    if (this.runButtonTop) {
      this.runButtonTop.disabled = false;
      this.runButtonTop.textContent = 'Run';
    }

    // Clear streaming messages
    this.streamingMessages.clear();

    this.focusInput();
  }
}

// Global function for example prompts
function useExample(prompt) {
  if (window.testDriverWebview) {
    window.testDriverWebview.useExample(prompt);
  }
}

// Global function for selecting examples
function selectExample(exampleName) {
  if (window.testDriverWebview) {
    // Send copy example command
    window.testDriverWebview.vscode.postMessage({
      command: 'sendMessage',
      message: `/copy-example ${exampleName}`
    });
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.testDriverWebview = new TestDriverWebview();
});
