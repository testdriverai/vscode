import * as vscode from 'vscode';
import * as path from 'path';
import { showTestDriverExamples, handleChatMessage, stopTestExecution } from '../commands/chat';
import { openInBottomGroup } from './layout';

export class TestDriverSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'testdriver-sidebar';

  private _view?: vscode.WebviewView;
  private _selectedFilePath = 'testdriver/testdriver.yaml';

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
      console.log('Sidebar received message:', message);
      switch (message.command) {
        case 'webviewReady': {
          console.log('Webview is ready, checking for examples...');
          // Webview is now ready to receive messages
          await this._checkAndShowExamples(webviewView);
          break;
        }
        case 'sendMessage': {
          await handleChatMessage(message.message, webviewView, this._context, this._selectedFilePath);
          break;
        }
        case 'runTests': {
          await this._handleRunTests();
          break;
        }
        case 'stopTest': {
          await this._handleStopTest(webviewView);
          break;
        }
        case 'selectFile': {
          await this._handleSelectFile(webviewView);
          break;
        }
        case 'openCurrentFile': {
          await this._handleOpenCurrentFile();
          break;
        }
      }
    });

    // Listen for active editor changes to update file indicator
    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (editor && this._isTestDriverFile(editor.document.uri)) {
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
          if (workspaceFolder) {
            const fileName = editor.document.uri.fsPath.split('/').pop() || 'test file';
            this._updateFileIndicator(workspaceFolder.name, fileName);
          }
        }
      })
    );
  }

  public postMessage(message: { command: string; data: string }) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  public getSelectedFilePath(): string {
    return this._selectedFilePath;
  }

  private _updateFileIndicator(workspaceName: string, fileName: string) {
    if (this._view) {
      this._view.webview.postMessage({
        command: 'updateFileIndicator',
        workspaceName: workspaceName,
        fileName: fileName
      });
    }
  }

  private _isTestDriverFile(uri: vscode.Uri): boolean {
    return uri.fsPath.includes('/testdriver/') &&
           (uri.fsPath.endsWith('.yml') || uri.fsPath.endsWith('.yaml'));
  }

  private async _handleStopTest(webviewView: vscode.WebviewView) {
    try {
      console.log('Stopping TestDriver test execution...');
      await stopTestExecution(webviewView);

      // Send message to webview to reset the UI state
      webviewView.webview.postMessage({
        command: 'testStopped'
      });

    } catch (error) {
      console.error('Error stopping test:', error);
      vscode.window.showErrorMessage('Failed to stop TestDriver test: ' + (error as Error).message);
    }
  }

  private async _handleSelectFile(webviewView: vscode.WebviewView) {
    try {
      console.log('Opening file selector...');

      // Get the current workspace folder
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
      }

      const workspaceFolder = workspaceFolders[0];

      // Look for YAML files in the testdriver folder and workspace root
      const yamlFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, '**/*.{yml,yaml}'),
        new vscode.RelativePattern(workspaceFolder, 'node_modules/**'),
        50
      );

      if (yamlFiles.length === 0) {
        vscode.window.showErrorMessage('No YAML files found in the workspace');
        return;
      }

      // Convert file URIs to relative paths for display
      const fileOptions = yamlFiles.map(fileUri => {
        const relativePath = vscode.workspace.asRelativePath(fileUri);
        return {
          label: relativePath,
          description: relativePath.includes('testdriver/') ? 'TestDriver file' : 'YAML file',
          uri: fileUri
        };
      });

      // Sort to prioritize testdriver files
      fileOptions.sort((a, b) => {
        if (a.label.includes('testdriver/') && !b.label.includes('testdriver/')) {
          return -1;
        }
        if (!a.label.includes('testdriver/') && b.label.includes('testdriver/')) {
          return 1;
        }
        return a.label.localeCompare(b.label);
      });

      // Show quick pick
      const selectedFile = await vscode.window.showQuickPick(fileOptions, {
        placeHolder: 'Select a YAML file for TestDriver chat',
        matchOnDescription: true
      });

      if (!selectedFile) {
        return; // User cancelled
      }

      const relativePath = selectedFile.label;
      console.log('Selected file:', relativePath);

      // Clear the chat and start fresh with the new file
      webviewView.webview.postMessage({
        command: 'clearChat'
      });

      // Update the file indicator
      webviewView.webview.postMessage({
        command: 'updateFileIndicator',
        workspaceName: workspaceFolder.name,
        fileName: relativePath
      });

      // Store the selected file path for use in chat messages
      this._selectedFilePath = relativePath;

      vscode.window.showInformationMessage(`Started new chat with file: ${relativePath}`);

    } catch (error) {
      console.error('Error selecting file:', error);
      vscode.window.showErrorMessage('Failed to select file: ' + (error as Error).message);
    }
  }

  private async _handleOpenCurrentFile() {
    try {
      console.log('Opening current file:', this._selectedFilePath);

      // Get the current workspace folder
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder found');
        return;
      }

      const workspaceFolder = workspaceFolders[0];
      const filePath = path.join(workspaceFolder.uri.fsPath, this._selectedFilePath);
      const fileUri = vscode.Uri.file(filePath);

      // Check if file exists
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch {
        vscode.window.showErrorMessage(`File not found: ${this._selectedFilePath}`);
        return;
      }

      // Open the file in the editor
      const document = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.One
      });

      console.log(`Successfully opened file: ${this._selectedFilePath}`);

    } catch (error) {
      console.error('Error opening current file:', error);
      vscode.window.showErrorMessage('Failed to open file: ' + (error as Error).message);
    }
  }

  private async _handleRunTests() {
    try {
      console.log('Running TestDriver tests for specific file...');

      // Get the target workspace folder
      const targetWorkspaceFolder = await this._getTargetWorkspaceFolder();
      if (!targetWorkspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found to run tests');
        return;
      }

      console.log('Target workspace folder:', targetWorkspaceFolder.uri.fsPath);

      // Focus on the Test Explorer first
      await vscode.commands.executeCommand('workbench.view.testing.focus');

      // First, try to find the active editor file if it's a test file
      let targetTestFile: vscode.Uri | undefined;
      const activeEditor = vscode.window.activeTextEditor;

      if (activeEditor &&
          activeEditor.document.uri.fsPath.includes('/testdriver/') &&
          (activeEditor.document.uri.fsPath.endsWith('.yml') || activeEditor.document.uri.fsPath.endsWith('.yaml'))) {
        targetTestFile = activeEditor.document.uri;
        console.log('Using active editor test file:', targetTestFile.fsPath);
      }

      // If no active test file, find the most relevant test file
      if (!targetTestFile) {
        const testdriverFiles = await vscode.workspace.findFiles(
          new vscode.RelativePattern(targetWorkspaceFolder, 'testdriver/**/*.{yml,yaml}'),
          null,
          10
        );

        if (testdriverFiles.length > 0) {
          // Prioritize main test files or use the first one
          targetTestFile = testdriverFiles.find(file =>
            file.fsPath.includes('testdriver.yml') || file.fsPath.includes('testdriver.yaml')
          ) || testdriverFiles[0];

          console.log('Using found test file:', targetTestFile.fsPath);

          // Open the test file in the bottom group (below any VM windows)
          await openInBottomGroup(targetTestFile, {
            preview: true
          });
        } else {
          vscode.window.showWarningMessage(`No TestDriver test files found in ${targetWorkspaceFolder.name}`);
          return;
        }
      }

      // Try to run the specific test file using multiple strategies
      if (targetTestFile) {
        const fileName = targetTestFile.fsPath.split('/').pop() || 'test file';
        console.log('Attempting to run test for file:', targetTestFile.fsPath);

        // Update the file indicator
        this._updateFileIndicator(targetWorkspaceFolder.name, fileName);

        // Send feedback to the webview about which file is being tested
        if (this._view) {
          this._view.webview.postMessage({
            command: 'testFileInfo',
            fileName: fileName
          });
        }

        try {
          // Strategy 1: Try VS Code's built-in "run current file" command
          await vscode.commands.executeCommand('testing.runCurrentFile');
          console.log('Successfully used testing.runCurrentFile');
          return;
        } catch (firstError) {
          console.log('testing.runCurrentFile failed:', firstError);
        }

        try {
          // Strategy 2: Try "run at cursor" which runs the test at the current cursor position
          await vscode.commands.executeCommand('testing.runAtCursor');
          console.log('Successfully used testing.runAtCursor');
          return;
        } catch (secondError) {
          console.log('testing.runAtCursor failed:', secondError);
        }

        try {
          // Strategy 3: Use the testdriver.runTest command specifically
          await vscode.commands.executeCommand('testdriver.runTest', targetTestFile);
          console.log('Successfully used testdriver.runTest');
          return;
        } catch (thirdError) {
          console.log('testdriver.runTest failed:', thirdError);
        }

        // Strategy 4: Fallback to running all tests with the specific file in focus
        console.log('All specific test commands failed, falling back to testing.runAll with file context');
        await vscode.commands.executeCommand('testing.runAll');
      }

    } catch (error) {
      console.error('Error running tests:', error);
      vscode.window.showErrorMessage('Failed to run TestDriver tests: ' + (error as Error).message);
    }
  }

  private async _getTargetWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    // Get the current workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      console.log('No workspace folders found');
      return undefined;
    }

    console.log('Available workspace folders:', workspaceFolders.map(f => f.uri.fsPath));

    // Check if we're in development mode (extension development workspace)
    const isExtensionDev = workspaceFolders.some(folder =>
      folder.uri.fsPath.includes('testdriver-vscode-extension')
    );

    // Find a workspace folder that doesn't have a testdriver folder
    // This prioritizes user project folders over the extension development folder
    let targetWorkspaceFolder = workspaceFolders[0]; // fallback to first

    for (const folder of workspaceFolders) {
      const testdriverFolderPath = vscode.Uri.file(folder.uri.fsPath + '/testdriver');
      try {
        const stat = await vscode.workspace.fs.stat(testdriverFolderPath);
        const hasTestdriverFolder = stat.type === vscode.FileType.Directory;
        console.log(`Folder ${folder.uri.fsPath} has testdriver folder:`, hasTestdriverFolder);

        if (!hasTestdriverFolder) {
          targetWorkspaceFolder = folder;
          break;
        }
      } catch {
        // Folder doesn't have testdriver directory, prefer this one
        console.log(`Folder ${folder.uri.fsPath} does not have testdriver folder`);
        targetWorkspaceFolder = folder;
        break;
      }
    }

    // In development mode, prefer the second workspace folder if available (likely the user's project)
    if (isExtensionDev && workspaceFolders.length > 1) {
      console.log('Extension development mode detected, using second workspace folder');
      targetWorkspaceFolder = workspaceFolders[1];
    }

    console.log('Target workspace folder:', targetWorkspaceFolder.uri.fsPath);
    return targetWorkspaceFolder;
  }

  private async _checkAndShowExamples(webviewView: vscode.WebviewView) {
    console.log('_checkAndShowExamples called');

    const targetWorkspaceFolder = await this._getTargetWorkspaceFolder();
    if (!targetWorkspaceFolder) {
      console.log('No workspace folders found');
      return;
    }

    // Check if the target workspace folder has a testdriver folder
    const testdriverFolderPath = vscode.Uri.file(targetWorkspaceFolder.uri.fsPath + '/testdriver');
    let showExamples = false;

    try {
      const stat = await vscode.workspace.fs.stat(testdriverFolderPath);
      const hasTestdriverFolder = stat.type === vscode.FileType.Directory;
      console.log(`Target folder ${targetWorkspaceFolder.uri.fsPath} has testdriver folder:`, hasTestdriverFolder);

      // Show examples if no testdriver folder exists
      showExamples = !hasTestdriverFolder;
    } catch {
      // Folder doesn't have testdriver directory
      console.log(`Target folder ${targetWorkspaceFolder.uri.fsPath} does not have testdriver folder`);
      showExamples = true;
    }

    // In development mode, always show examples for testing purposes
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const isExtensionDev = workspaceFolders?.some(folder =>
      folder.uri.fsPath.includes('testdriver-vscode-extension')
    );

    if (isExtensionDev && !showExamples) {
      console.log('Extension development mode detected, showing examples for testing');
      showExamples = true;
    }

    console.log('Target workspace folder:', targetWorkspaceFolder.uri.fsPath);
    console.log('Show examples:', showExamples);

    // Update file indicator with workspace info
    this._updateFileIndicator(targetWorkspaceFolder.name, showExamples ? 'Getting started' : 'testdriver.yml');

    // If we should show examples, load them
    if (showExamples) {
      console.log('Loading examples for workspace folder:', targetWorkspaceFolder.uri.fsPath);
      await showTestDriverExamples(targetWorkspaceFolder, webviewView.webview);
      console.log('showTestDriverExamples completed');

      // Hide both the input area and run button when showing examples
      webviewView.webview.postMessage({
        command: 'hideInputAndRunButton'
      });
    } else {
      console.log('Target workspace folder has testdriver folder, not showing examples');

      // Show the input area and run button when not showing examples
      webviewView.webview.postMessage({
        command: 'showInputAndRunButton'
      });

      // Try to find the main test file and update the indicator
      const testdriverFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(targetWorkspaceFolder, 'testdriver/**/*.{yml,yaml}'),
        null,
        5
      );

      if (testdriverFiles.length > 0) {
        const mainTestFile = testdriverFiles.find(file =>
          file.fsPath.includes('testdriver.yml') || file.fsPath.includes('testdriver.yaml')
        ) || testdriverFiles[0];

        const fileName = mainTestFile.fsPath.split('/').pop() || 'test file';
        this._updateFileIndicator(targetWorkspaceFolder.name, fileName);
      }
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

          .file-indicator {
            padding: 6px 8px;
            background-color: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-sideBar-border);
            flex-shrink: 0;
            display: block; /* Always visible */
            border-left: 3px solid var(--vscode-testing-runAction);
            font-size: 11px;
          }

          .file-info {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 6px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
          }

          .select-file-button {
            background: none;
            border: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            padding: 2px 4px;
            border-radius: 2px;
            font-size: 12px;
            opacity: 0.7;
            transition: opacity 0.2s ease;
          }

          .select-file-button:hover {
            opacity: 1;
            background-color: var(--vscode-button-secondaryHoverBackground);
          }

          .file-icon {
            width: 14px;
            height: 14px;
            opacity: 0.8;
            font-size: 12px;
          }

          .file-path {
            color: var(--vscode-textLink-foreground);
            font-size: 12px;
          }

          .file-path.clickable {
            cursor: pointer;
            text-decoration: underline;
            text-decoration-color: transparent;
            transition: text-decoration-color 0.2s ease;
          }

          .file-path.clickable:hover {
            text-decoration-color: var(--vscode-textLink-foreground);
          }

          .workspace-name {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
          }

          .chat-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }

          .messages {
            flex: 1;
            padding: 8px;
            overflow-y: auto;
            overflow-x: hidden; /* Prevent horizontal scrolling */
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
            font-size: 13px;
          }

          .message.user {
            flex-direction: row-reverse;
          }

          .message.user .message-content {
            background-color: var(--vscode-chat-requestBubbleBackground);
            border-radius: 8px;
            padding: 8px 12px;
            max-width: 90%;
            margin-left: auto;
            width: fit-content;
          }

          .message-avatar {
            width: 16px;
            height: 16px;
            display: none; /* Hide all avatar icons */
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
            /* Remove background for cleaner look */
          }

          .message-content {
            font-family: var(--vscode-editor-font-family), 'Courier New', monospace;
            background-color: transparent; /* Remove background */
            border: none; /* Remove border */
            border-radius: 6px;
            max-width: 100%; /* Use full width since no avatar */
            word-wrap: break-word;
            overflow-wrap: break-word; /* Better word breaking */
            line-height: 1.4;
            min-width: 0; /* Allow content to shrink */
          }

          .message.status .message-content {
            background-color: transparent; /* Remove background */
            border: none; /* Remove border */
          }

          .message.loading .message-content {
            background-color: transparent; /* Remove background */
            border: none; /* Remove border */
            animation: pulse 1.5s infinite;
          }

          .message.error .message-content {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-errorForeground, #f14c4c);
            border-left: 3px solid var(--vscode-errorForeground, #f14c4c);
            border-radius: 3px;
            padding: 8px;
            font-family: var(--vscode-editor-font-family), 'Courier New', monospace;
            color: var(--vscode-errorForeground, #f14c4c);
            white-space: pre-wrap;
            word-break: break-word;
            overflow-wrap: break-word;
          }

          @keyframes pulse {
            0%, 100% { opacity: 0.6; }
            50% { opacity: 1; }
          }

          .loading-content {
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .loading-text {
            color: var(--vscode-descriptionForeground);
          }

          .code-block {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-textBlockQuote-border);
            border-radius: 3px;
            padding: 8px; /* Slightly more padding since no message background */
            margin: 4px 0;
            font-family: var(--vscode-editor-font-family), "Droid Sans Mono", Menlo, Monaco, "Courier New", monospace;
            font-size: 12px;
            overflow-x: auto;
            overflow-y: hidden;
            white-space: pre;
            max-width: 100%;
            color: #b3d334 !important;
            word-wrap: normal; /* Don't break words in code */
          }

          .code-block.yaml {
            border: none !important;
            border-left: 3px solid var(--vscode-textLink-foreground);
            background-color: var(--vscode-textBlockQuote-background);
          }

          .code-block code {
            background: none !important;
            border: none !important;
            padding: 0 !important;
            margin: 0 !important;
            font-family: inherit !important;
            color: #b3d334 !important;
            white-space: pre;
            overflow-wrap: normal;
          }

          /* Prism.js VS Code theme integration */
          .code-block pre[class*="language-"] {
            background: none !important;
            margin: 0 !important;
            padding: 0 !important;
            border: none !important;
            border-radius: 0 !important;
          }

          .code-block code[class*="language-"] {
            background: none !important;
            color: #b3d334 !important;
          }

          /* Override Prism.js tokens to use VS Code colors */
          .token.comment,
          .token.prolog,
          .token.doctype,
          .token.cdata {
            color: var( #b3d334) !important;
          }

          .token.property,
          .token.tag,
          .token.boolean,
          .token.number,
          .token.constant,
          .token.symbol,
          .token.deleted {
            color: #b3d334 !important;
          }

          .token.selector,
          .token.attr-name,
          .token.string,
          .token.char,
          .token.builtin,
          .token.inserted {
            color: #b3d334 !important;
          }

          .token.operator,
          .token.entity,
          .token.url,
          .language-css .token.string,
          .style .token.string {
            color: var(--vscode-editor-foreground) !important;
          }

          .token.atrule,
          .token.attr-value,
          .token.keyword {
            color: #34d3d3 !important;
          }

          .token.function,
          .token.class-name {
            color: #DCDCAA !important;
          }

          .token.regex,
          .token.important,
          .token.variable {
            color: #9CDCFE !important;
          }

          /* VS Code icon styling */
          .codicon {
            font-family: "codicon";
            font-size: inherit;
          }

          /* Loading spinner should be neutral colored */
          .codicon-loading {
            color: var(--vscode-progressBar-background, var(--vscode-foreground)) !important;
          }

          /* Success checkmark should be green */
          .codicon-check {
            color: var(--vscode-debugIcon-startForeground) !important;
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

          .button-row {
            display: flex;
            gap: 6px;
            align-items: center;
          }

          .chat-input {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            padding: 6px;
            font-size: 12px;
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
            font-size: 12px;
            flex: 1;
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

          .run-button-small {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 3px;
            padding: 6px 8px;
            cursor: pointer;
            font-size: 11px;
            flex-shrink: 0;
            height: 28px;
            white-space: nowrap;
          }

          .run-button-small:hover:not(:disabled) {
            background-color: var(--vscode-button-secondaryHoverBackground);
          }

          .run-button-small:disabled {
            opacity: 0.6;
            cursor: not-allowed;
          }

          #runButton {
            background-color: var(--vscode-testing-runAction);
            margin-top: 6px;
          }

          #runButton:hover:not(:disabled) {
            background-color: var(--vscode-button-hoverBackground);
          }

          #runButton:disabled {
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
            padding: 24px 16px;
          }

          .empty-state .helmet-large {
            width: 48px;
            height: 48px;
            margin-bottom: 16px;
            opacity: 0.8;
          }

          .empty-state h3 {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
          }

          .empty-state p {
            font-size: 13px;
            line-height: 1.5;
            margin-bottom: 20px;
            max-width: 280px;
            color: var(--vscode-descriptionForeground);
          }

          .example-prompts {
            display: flex;
            flex-direction: column;
            gap: 6px;
            width: 100%;
            max-width: 280px;
          }

          .example-prompt {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 6px;
            padding: 8px 12px;
            cursor: pointer;
            font-size: 12px;
            text-align: left;
            line-height: 1.3;
            transition: all 0.15s ease;
            min-height: 32px;
            display: flex;
            align-items: center;
            cursor: pointer;
          }

          .example-prompt:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
            border-color: var(--vscode-focusBorder);
            transform: translateY(-1px);
          }

          /* Examples selection styles */
          .examples-selection h4 {
            margin: 0 0 8px 0;
            font-size: 12px;
            color: var(--vscode-foreground);
          }

          .examples-selection p {
            margin: 0 0 12px 0;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
          }

          .examples-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 8px;
            margin-bottom: 8px;
          }

          .example-button {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            padding: 12px 8px;
            cursor: pointer;
            text-align: center;
            transition: background-color 0.1s ease;
          }

          .example-button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
          }

          .example-name {
            font-size: 12px;
          }

          .examples-note {
            font-size: 10px;
            font-style: italic;
            color: var(--vscode-descriptionForeground);
            margin-top: 8px !important;
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
              <h3>Welcome to TestDriver.ai</h3>
              <p>Your AI-powered testing assistant. Describe what you want to test and I'll help you create automated test steps.</p>
              <div class="example-prompts" id="examplePrompts">
                <button class="example-prompt" onclick="fillInput('Assert the app loads properly')">Assert the app loaded</button>
                <button class="example-prompt" onclick="fillInput('Test the login form with valid credentials')">Test the login form with valid credentials</button>
                <button class="example-prompt" onclick="fillInput('Close the browser')">Close the browser</button>
              </div>
            </div>
          </div>

          <div class="file-indicator" id="fileIndicator">
            <div class="file-info">
              <span class="file-path clickable" id="currentFile" title="Click to open file">testdriver/testdriver.yaml</span>
              <button id="selectFileButton" class="select-file-button" title="Select a different file">
                <span class="codicon codicon-folder-opened"></span>
              </button>
            </div>
          </div>

          <div class="input-container">
                          <textarea
                id="chatInput"
                placeholder="What would you like to test?"
                style="flex: 1; padding: 12px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); resize: none; border-radius: 4px; font-family: var(--vscode-font-family); line-height: 1.3; min-height: 20px; max-height: 80px; overflow-y: auto;"
              ></textarea>
            <div class="button-row">
              <button id="runButtonTop" class="run-button-small">Run</button>
              <button id="sendButton" class="send-button">Generate Test Steps</button>
            </div>
          </div>
        </div>

        <!-- Marked.js for markdown processing -->
        <script src="https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js"></script>

        <!-- Prism.js for syntax highlighting -->
        <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css" rel="stylesheet" />
        <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-dark.min.css" rel="stylesheet" media="(prefers-color-scheme: dark)" />
        <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-core.min.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js"></script>

        <!-- VS Code Codicons -->
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.33/dist/codicon.css">

        <script>
          // Configure Prism.js autoloader
          if (window.Prism) {
            window.Prism.plugins.autoloader.languages_path = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/';
          }
        </script>

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
