import * as vscode from 'vscode';
import * as path from 'path';
import { openTestDriverWebview } from '../utils/webview';
import { openInBottomGroup } from '../utils/layout';
import { track, logger } from '../utils/logger';
import {
  initializeDecorations,
  disposeDecorations,
  addCommandStatus,
  clearCommandStatuses,
  registerDecorationUpdates
} from '../utils/decorations';

// Import dotenv to load environment variables
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dotenv = require('dotenv');

// Import the TestDriver agent directly from the package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestDriverAgent = require('testdriverai');

// Import ansi-to-html for processing ANSI codes
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AnsiToHtml = require('ansi-to-html');

// Import Node.js fs module for reading directories
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');

// Get examples from testdriverai package using fs
let testdriverExamples: string[] = [];
try {
  const testdriveraiPath = require.resolve('testdriverai');
  const packageRoot = path.dirname(testdriveraiPath);
  const examplesPath = path.join(packageRoot, 'testdriver', 'examples');

  console.log('Startup: testdriveraiPath:', testdriveraiPath);
  console.log('Startup: packageRoot:', packageRoot);
  console.log('Startup: examplesPath:', examplesPath);

  if (fs.existsSync(examplesPath)) {
    testdriverExamples = fs.readdirSync(examplesPath).filter((file: string) => {
      return fs.statSync(path.join(examplesPath, file)).isDirectory();
    });
    console.log('Startup: Found testdriverai examples:', testdriverExamples);
  } else {
    console.log('Startup: Examples path does not exist:', examplesPath);
  }
} catch (error) {
  console.log('Startup: Could not load testdriverai examples:', error);
}

/**
 * Load environment variables from the workspace .env file
 * This ensures testdriverai gets the correct environment variables from the user's workspace
 * Uses override: true to reload variables even if they already exist in process.env
 */
function loadWorkspaceEnv(workspaceFolder: vscode.WorkspaceFolder): void {
  const workspaceEnvPath = path.join(workspaceFolder.uri.fsPath, '.env');
  try {
    // Use override: true to force reload of environment variables even if they already exist
    const envResult = dotenv.config({ path: workspaceEnvPath, override: true });
    if (envResult.error) {
      console.log('No .env file found in workspace folder or error loading it:', envResult.error.message);
    } else {
      console.log('Successfully loaded .env file from workspace folder (with override)');
      // Log the TestDriver-specific environment variables that were loaded
      const tdVars = Object.keys(process.env).filter(key => key.startsWith('TD_'));
      if (tdVars.length > 0) {
        console.log('TestDriver environment variables loaded:', tdVars);
      }
    }
  } catch (e) {
    console.log('Error loading .env file from workspace folder:', e);
  }
}

/**
 * Create an ANSI to HTML converter configured for VS Code theme colors
 */
function createAnsiConverter(): typeof AnsiToHtml {
  return new AnsiToHtml({
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
}

/**
 * Process a string that may contain ANSI codes and convert them to HTML
 */
function processAnsiToHtml(text: string, converter: typeof AnsiToHtml): string {
  if (!text || typeof text !== 'string') {
    return text;
  }

  try {
    return converter.toHtml(text);
  } catch (error) {
    console.warn('Failed to convert ANSI to HTML:', error);
    // Fallback: remove ANSI codes using proper escape sequence
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }
}

/**
 * Process agent event data to convert any ANSI codes to HTML
 */
function processEventData(args: unknown[], converter: typeof AnsiToHtml): unknown[] {
  return args.map(arg => {
    if (typeof arg === 'string') {
      return processAnsiToHtml(arg, converter);
    } else if (typeof arg === 'object' && arg !== null) {
      // Recursively process object properties
      const processed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(arg)) {
        if (typeof value === 'string') {
          processed[key] = processAnsiToHtml(value, converter);
        } else {
          processed[key] = value;
        }
      }
      return processed;
    }
    return arg;
  });
}

/**
 * Process event data for error events - don't convert ANSI to HTML for errors
 */
function processErrorEventData(args: unknown[]): unknown[] {
  return args.map(arg => {
    if (typeof arg === 'string') {
      // For errors, just strip ANSI codes instead of converting to HTML
      // eslint-disable-next-line no-control-regex
      return arg.replace(/\x1b\[[0-9;]*m/g, '');
    } else if (typeof arg === 'object' && arg !== null) {
      // Recursively process object properties
      const processed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(arg)) {
        if (typeof value === 'string') {
          // eslint-disable-next-line no-control-regex
          processed[key] = value.replace(/\x1b\[[0-9;]*m/g, '');
        } else {
          processed[key] = value;
        }
      }
      return processed;
    }
    return arg;
  });
}

/**
 * Open a file and highlight a specific line/column
 */
async function openAndHighlightFile(filePath: string, lineNumber?: number, columnNumber?: number): Promise<void> {
  try {
    console.log(`Attempting to open file: ${filePath}, line: ${lineNumber}, column: ${columnNumber}`);

    const fileUri = vscode.Uri.file(filePath);

    // Check if file exists
    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      console.error(`File does not exist: ${filePath}`);
      return;
    }

    // Check if the file is already open in any editor group
    const existingEditors = vscode.window.visibleTextEditors;
    let targetEditor: vscode.TextEditor | undefined;

    for (const editor of existingEditors) {
      if (editor.document.uri.fsPath === filePath) {
        // File is already open, check if it's in the bottom group (ViewColumn.Two)
        if (editor.viewColumn === vscode.ViewColumn.Two) {
          targetEditor = editor;
          console.log(`File already open in bottom group: ${filePath}`);
          break;
        }
      }
    }

    // If not already open in bottom group, open it there
    if (!targetEditor) {
      const document = await openInBottomGroup(fileUri, {
        preview: false,
        preserveFocus: false
      });

      if (!document) {
        console.error('Could not open document in bottom group');
        return;
      }

      targetEditor = document;
      console.log(`Successfully opened file in bottom group: ${filePath}`);
    }

    // Focus on the target editor to ensure it's active
    await vscode.window.showTextDocument(targetEditor.document, {
      viewColumn: targetEditor.viewColumn,
      preserveFocus: false,
      preview: false
    });

    // Highlight the specific line if provided
    if (lineNumber !== undefined && lineNumber > 0 && targetEditor) {
      const line = Math.max(0, lineNumber - 1); // Convert to 0-based indexing
      const column = Math.max(0, (columnNumber || 1) - 1); // Convert to 0-based indexing

      console.log(`Highlighting line ${line + 1}, column ${column + 1} (0-based: ${line}, ${column})`);

      // Ensure the line number is valid for the document
      if (line < targetEditor.document.lineCount) {
        // Create a range that spans the entire line for better visibility
        const lineText = targetEditor.document.lineAt(line);
        const range = new vscode.Range(
          new vscode.Position(line, 0),
          new vscode.Position(line, lineText.text.length)
        );

        // Set selection and reveal the range
        targetEditor.selection = new vscode.Selection(range.start, range.end);
        targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

        console.log(`Highlighted range: line ${range.start.line + 1} to ${range.end.line + 1}`);
      } else {
        console.warn(`Line number ${lineNumber} exceeds document length (${targetEditor.document.lineCount} lines)`);
      }
    } else {
      console.log('No line number provided for highlighting');
    }
  } catch (error) {
    console.error('Failed to open and highlight file:', error);
  }
}

interface StepInfo {
  stepIndex: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  prompt?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}

interface CommandInfo {
  commandIndex: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  command: string;
}

interface SourcePosition {
  filePath: string;
  step?: StepInfo;
  command?: CommandInfo;
  lineNumber?: number;
  columnNumber?: number;
}

interface EventData {
  sourcePosition?: SourcePosition;
  source?: SourcePosition;
  position?: SourcePosition;
  [key: string]: unknown;
}

export function registerChatCommand(context: vscode.ExtensionContext) {
  // Initialize decorations for chat command
  initializeDecorations(context);
  registerDecorationUpdates();

  // Dispose decorations when extension is deactivated
  context.subscriptions.push({
    dispose: disposeDecorations
  });

  const disposable = vscode.commands.registerCommand('testdriver.openChat', async () => {
    track({ event: 'chat.opened' });

    // Focus on the TestDriver sidebar view instead of creating a separate webview panel
    await vscode.commands.executeCommand('testdriver-sidebar.focus');
  });

  context.subscriptions.push(disposable);
}

/**
 * List available TestDriver examples from testdriverai package
 */
async function showTestDriverExamples(workspaceFolder: vscode.WorkspaceFolder, webview: vscode.Webview | vscode.WebviewView['webview']): Promise<void> {
  try {
    let examples: string[] = [];

    console.log('=== DEBUG showTestDriverExamples ===');
    console.log('showTestDriverExamples - global testdriverExamples:', testdriverExamples);
    console.log('showTestDriverExamples - global testdriverExamples.length:', testdriverExamples.length);
    console.log('=== END DEBUG ===');

    // First try to use the global variable
    if (testdriverExamples && testdriverExamples.length > 0) {
      examples = testdriverExamples;
      console.log('Found examples from global testdriverExamples:', examples);
    } else {
      console.log('Global testdriverExamples not available, trying fresh load...');

      // Try to load examples fresh using the same logic as startup
      try {
        const testdriveraiPath = require.resolve('testdriverai');
        const packageRoot = path.dirname(testdriveraiPath);
        const examplesPath = path.join(packageRoot, 'testdriver', 'examples');

        console.log('Fresh load - testdriveraiPath:', testdriveraiPath);
        console.log('Fresh load - packageRoot:', packageRoot);
        console.log('Fresh load - examplesPath:', examplesPath);

        if (fs.existsSync(examplesPath)) {
          examples = fs.readdirSync(examplesPath).filter((file: string) => {
            return fs.statSync(path.join(examplesPath, file)).isDirectory();
          });
          console.log('Fresh load - Found examples:', examples);
        } else {
          console.log('Fresh load - Examples path does not exist:', examplesPath);
        }
      } catch (freshLoadError) {
        console.log('Fresh load failed:', freshLoadError);
      }

      // If fresh load didn't work, try VS Code workspace fallback
      if (examples.length === 0) {
        try {
          const nodeModulesPath = path.join(workspaceFolder.uri.fsPath, 'node_modules', 'testdriverai', 'testdriver', 'examples');
          console.log('Checking workspace node_modules path:', nodeModulesPath);
          const examplesUri = vscode.Uri.file(nodeModulesPath);
          const files = await vscode.workspace.fs.readDirectory(examplesUri);
          examples = files
            .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.'))
            .map(([name]) => name);
          console.log('Found examples from workspace node_modules:', examples);
        } catch (dirError) {
          console.log('Could not read examples from workspace node_modules:', dirError);
          // Final fallback to actual available examples
          examples = ['arc-browser', 'chrome-extension', 'doom', 'mobile', 'npm', 'performance', 'playwright-test-recording', 'vscode-extension', 'web'];
          console.log('Using hardcoded fallback examples:', examples);
        }
      }
    }

    // Send examples list to webview
    webview.postMessage({
      command: 'showExamples',
      examples: examples.map(example => ({
        name: example,
        displayName: example.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
      }))
    });

  } catch (error) {
    console.error('Error showing examples:', error);
    webview.postMessage({
      command: 'error',
      data: 'Failed to load TestDriver examples'
    });
  }
}

/**
 * Recursively copy a directory using Node.js fs module
 */
async function copyDirectoryRecursively(sourceDir: string, destDir: string): Promise<void> {
  const items = fs.readdirSync(sourceDir);

  for (const item of items) {
    const sourcePath = path.join(sourceDir, item);
    const destPath = path.join(destDir, item);
    const stat = fs.statSync(sourcePath);

    if (stat.isDirectory()) {
      // Create directory and recursively copy contents
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(destPath));
      } catch {
        // Directory might already exist
      }
      await copyDirectoryRecursively(sourcePath, destPath);
    } else if (stat.isFile()) {
      // Copy file
      const content = fs.readFileSync(sourcePath, 'utf8');
      await vscode.workspace.fs.writeFile(vscode.Uri.file(destPath), new TextEncoder().encode(content));
    }
  }
}

/**
 * Recursively copy a directory using VS Code workspace API
 */
async function copyDirectoryRecursivelyVscode(sourceDir: string, destDir: string): Promise<void> {
  const sourceUri = vscode.Uri.file(sourceDir);
  const files = await vscode.workspace.fs.readDirectory(sourceUri);

  for (const [fileName, fileType] of files) {
    const sourcePath = path.join(sourceDir, fileName);
    const destPath = path.join(destDir, fileName);

    if (fileType === vscode.FileType.Directory) {
      // Create directory and recursively copy contents
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(destPath));
      } catch {
        // Directory might already exist
      }
      await copyDirectoryRecursivelyVscode(sourcePath, destPath);
    } else if (fileType === vscode.FileType.File) {
      // Copy file
      const sourceFileUri = vscode.Uri.file(sourcePath);
      const destFileUri = vscode.Uri.file(destPath);
      await vscode.workspace.fs.copy(sourceFileUri, destFileUri, { overwrite: true });
    }
  }
}

/**
 * Find the main test file in a directory (looks for testdriver.yaml or similar)
 */
function findMainTestFile(directory: string): string {
  const items = fs.readdirSync(directory, { withFileTypes: true });

  // Look for common main test file patterns
  const commonNames = ['testdriver.yaml', 'testdriver.yml', 'test.yaml', 'test.yml'];

  for (const name of commonNames) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (items.some((item: any) => item.isFile() && item.name === name)) {
      return name;
    }
  }

  // Fallback: find any YAML file that contains 'testdriver' in the name
  for (const item of items) {
    if (item.isFile() && item.name.includes('testdriver') && (item.name.endsWith('.yaml') || item.name.endsWith('.yml'))) {
      return item.name;
    }
  }

  // Final fallback: find any YAML file
  for (const item of items) {
    if (item.isFile() && (item.name.endsWith('.yaml') || item.name.endsWith('.yml'))) {
      return item.name;
    }
  }

  return 'testdriver.yaml'; // default fallback
}

/**
 * Copy an example to the workspace testdriver folder
 */
async function copyExampleToWorkspace(exampleName: string, workspaceFolder: vscode.WorkspaceFolder, webview: vscode.Webview | vscode.WebviewView['webview']): Promise<void> {
  try {
    const workspaceTestdriverPath = path.join(workspaceFolder.uri.fsPath, 'testdriver');

    // Create testdriver directory if it doesn't exist
    const testdriverUri = vscode.Uri.file(workspaceTestdriverPath);
    try {
      await vscode.workspace.fs.createDirectory(testdriverUri);
    } catch {
      // Directory might already exist, which is fine
    }

    let mainFileName = 'testdriver.yaml';
    let copySuccess = false;

    // Try to copy from the testdriverai package using fs
    try {
      const testdriveraiPath = require.resolve('testdriverai');
      const packageRoot = path.dirname(testdriveraiPath);
      const sourceExamplePath = path.join(packageRoot, 'testdriver', 'examples', exampleName);

      if (fs.existsSync(sourceExamplePath) && fs.statSync(sourceExamplePath).isDirectory()) {
        // Recursively copy the entire directory structure
        await copyDirectoryRecursively(sourceExamplePath, workspaceTestdriverPath);

        // Find the main test file after copying
        mainFileName = findMainTestFile(workspaceTestdriverPath);

        copySuccess = true;
        console.log('Copied example from testdriverai package using fs:', exampleName);
      }
    } catch (fsError) {
      console.log('Could not copy from testdriverai package using fs:', fsError);
    }

    // Fallback: try to read from node_modules directory structure using VS Code API
    if (!copySuccess) {
      try {
        const nodeModulesExamplePath = path.join(workspaceFolder.uri.fsPath, 'node_modules', 'testdriverai', 'testdriver', 'examples', exampleName);

        // Check if source directory exists
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(nodeModulesExamplePath));
        if (stat.type === vscode.FileType.Directory) {
          // Copy the entire example directory contents recursively
          await copyDirectoryRecursivelyVscode(nodeModulesExamplePath, workspaceTestdriverPath);

          // Find the main test file after copying
          mainFileName = findMainTestFile(workspaceTestdriverPath);

          copySuccess = true;
          console.log('Copied example from node_modules directory:', exampleName);
        }
      } catch (dirError) {
        console.log('Could not copy from node_modules directory:', dirError);
      }
    }

    if (!copySuccess) {
      throw new Error(`Example not found: ${exampleName}`);
    }

    // Open the main test file in bottom group
    const mainTestFile = path.join(workspaceTestdriverPath, mainFileName);
    await openInBottomGroup(vscode.Uri.file(mainTestFile), {
      preview: false
    });

    webview.postMessage({
      command: 'agentEvent',
      eventName: 'log:info',
      data: [`Copied ${exampleName} example to testdriver/ folder and opened it for editing.`]
    });

    // Show the input and run buttons now that we have a testdriver folder
    webview.postMessage({
      command: 'showInputAndRunButton'
    });

    // Update the file indicator to show the new test file
    webview.postMessage({
      command: 'updateFileIndicator',
      workspaceName: workspaceFolder.name,
      fileName: mainFileName
    });

    // Show suggested prompts after copying example
    webview.postMessage({
      command: 'showSuggestedPromptsAfterExample'
    });

    webview.postMessage({
      command: 'chatResponse'
    });

  } catch (error) {
    console.error('Error copying example:', error);
    webview.postMessage({
      command: 'error',
      data: `Failed to copy example: ${error instanceof Error ? error.message : 'Unknown error'}`
    });

    webview.postMessage({
      command: 'chatResponse'
    });
  }
}

// Function to stop the current test execution
async function stopTestExecution(panel?: vscode.WebviewPanel | vscode.WebviewView): Promise<void> {
  if (globalAgent) {
    try {
      console.log('Stopping TestDriver agent...');

      // First, set the stopped flag to immediately halt execution
      if (typeof globalAgent.stop === 'function') {
        globalAgent.stop();
      } else {
        // Fallback for older agent versions - set stopped flag directly
        globalAgent.stopped = true;
      }

      // Send message to webview to stop any spinners immediately
      if (panel) {
        const webview = 'webview' in panel ? panel.webview : panel;
        webview.postMessage({
          command: 'agentEvent',
          eventName: 'exit',
          data: [null],
          timestamp: Date.now()
        });
      }

      // Then call exit to clean up
      await globalAgent.exit();
      globalAgent = null;
      console.log('TestDriver agent stopped and removed from memory');
    } catch (error) {
      console.error('Error stopping TestDriver agent:', error);
      // Force clear the global agent even if exit fails
      globalAgent = null;
    }
  } else {
    console.log('No active TestDriver agent to stop');
  }
}

export { handleChatMessage, showTestDriverExamples, stopTestExecution };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let globalAgent: any = null;
let currentFilePath = 'testdriver/testdriver.yaml';

async function handleChatMessage(userMessage: string, panel: vscode.WebviewPanel | vscode.WebviewView, context: vscode.ExtensionContext, selectedFilePath?: string) {
  try {
    track({ event: 'chat.message.sent', properties: { messageLength: userMessage.length } });

    // Get the current workspace folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      const webview = 'webview' in panel ? panel.webview : panel;
      webview.postMessage({
        command: 'error',
        data: 'No workspace folder found. Please open a project workspace first.'
      });
      return;
    }

    const workspaceFolder = workspaceFolders[0];

    // Check if testdriver folder exists in workspace
    const testdriverFolderPath = path.join(workspaceFolder.uri.fsPath, 'testdriver');
    let testdriverFolderExists = false;
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(testdriverFolderPath));
      testdriverFolderExists = stat.type === vscode.FileType.Directory;
    } catch {
      testdriverFolderExists = false;
    }

    // If no testdriver folder, show examples selection
    if (!testdriverFolderExists) {
      const webview = 'webview' in panel ? panel.webview : panel;

      // Check if this is a request to copy an example
      if (userMessage.startsWith('/copy-example ')) {
        const exampleName = userMessage.replace('/copy-example ', '').trim();
        await copyExampleToWorkspace(exampleName, workspaceFolder, webview);
        return;
      }

      // Show available examples
      await showTestDriverExamples(workspaceFolder, webview);
      return;
    }

    // Load .env file from workspace folder to ensure testdriverai gets the right environment variables
    loadWorkspaceEnv(workspaceFolder);

    // Get API key from context if available
    let apiKey: string | undefined;
    if (context) {
      apiKey = await context.secrets.get('TD_API_KEY');
      console.log('Retrieved API key from secrets:', apiKey ? 'present' : 'missing');
    } else {
      console.log('No context available for API key retrieval');
    }

    // If no API key from secrets, try to get it from environment variables (loaded from .env)
    if (!apiKey && process.env.TD_API_KEY) {
      apiKey = process.env.TD_API_KEY;
      console.log('Retrieved API key from environment variables:', apiKey ? 'present' : 'missing');
    }

    // Check if API key is missing and show popup
    if (!apiKey) {
      const result = await vscode.window.showErrorMessage(
        'TestDriver: API key is required to run tests. Please set your API key.',
        'Set API Key'
      );
      if (result === 'Set API Key') {
        vscode.commands.executeCommand('testdriver.setApiKey');
      }
      const webview = 'webview' in panel ? panel.webview : panel;
      webview.postMessage({
        command: 'error',
        data: 'API key is required to use TestDriver chat.'
      });
      return;
    }

    const originalCwd: string = process.cwd();

    try {
      // Change process working directory to the workspace folder
      process.chdir(workspaceFolder.uri.fsPath);

      // Prepare environment variables for the agent
      const agentEnvironment = {
        TD_API_KEY: apiKey,
        ...process.env // Include other environment variables
      };

      // Set working directory to the workspace folder
      const workingDir = workspaceFolder.uri.fsPath;

      // Set up CLI args for the agent in "edit" mode (interactive mode)
      // This is like running: npx testdriverai@latest edit (which enters interactive mode)
      const targetFilePath = selectedFilePath || 'testdriver/testdriver.yaml';

      // If the file path has changed, reset the agent to start a new session
      if (targetFilePath !== currentFilePath) {
        console.log(`File path changed from ${currentFilePath} to ${targetFilePath}, resetting agent`);
        globalAgent = null;
        currentFilePath = targetFilePath;
      }

      const cliArgs = {
        command: 'edit',
        args: [targetFilePath], // Use the selected file path
        options: {
          // new: true
        },
      };

      console.log('CLI args being passed to agent:', JSON.stringify(cliArgs, null, 2));

      // Create agent with environment and CLI args
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let agent: any = globalAgent;

      // Store the agent globally so it can be reused for subsequent messages
      if (!agent) {
        globalAgent = new TestDriverAgent(agentEnvironment, cliArgs);
        agent = globalAgent;

        console.log('Created agent with configuration:', {
          environment: agentEnvironment.TD_API_KEY ? 'API key present' : 'No API key',
          workingDir: workingDir,
          agentWorkingDir: agent.workingDir,
          agentCliArgs: agent.cliArgs,
          isReusedAgent: !!globalAgent
        });

        // Track that we're running a chat session
        let chatEnded = false;

        // Create ANSI to HTML converter
        const ansiConverter = createAnsiConverter();

        // Unified event forwarding - listen to all events and forward them to webview
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agent.emitter.onAny((eventName: string, ...args: any[]) => {
          console.log('Received agent event:', eventName, args);

          // Process event data differently for error events vs regular events
          let processedArgs: unknown[];
          if (eventName.startsWith('error:')) {
            // For error events, strip ANSI codes but don't convert to HTML
            processedArgs = processErrorEventData(args);
          } else {
            // For regular events, convert ANSI codes to HTML
            processedArgs = processEventData(args, ansiConverter);
          }

          const webview = 'webview' in panel ? panel.webview : panel;
          webview.postMessage({
            command: 'agentEvent',
            eventName: eventName,
            data: processedArgs,
            timestamp: Date.now()
          });
        });

        // Handle show-window event to open TestDriver webview instead of external browser
        // This needs to be bound early, before agent.start() or buildEnv(), as the event might be emitted during initialization
        agent.emitter.on('show-window', async (url: string) => {
          console.log('show-window event received with URL:', url);
          // Use the test file name as the webview title
          const testFileName = 'TestDriver Session';
          await openTestDriverWebview(context, url, `${testFileName} - TestDriver`);
        });

        // Start the agent first
        console.log('Starting agent...');
        await agent.start();

        // Build the environment (sandbox) for interactive mode
        console.log('Building environment...');
        await agent.buildEnv({ });

        // Handle step:start events to open and highlight files
        agent.emitter.on('step:start', async (data: EventData) => {
          console.log('Step started - full data:', JSON.stringify(data, null, 2));

          if (data.sourcePosition && data.sourcePosition.filePath) {
            const sourcePos = data.sourcePosition;
            const step = sourcePos.step;

            if (step) {
              console.log('Opening file for step:', sourcePos.filePath, 'line:', step.startLine);
              await openAndHighlightFile(sourcePos.filePath, step.startLine, step.startColumn);

              // Add gutter decoration for running step
              const fileUri = vscode.Uri.file(sourcePos.filePath);
              addCommandStatus(fileUri.toString(), {
                line: step.startLine,
                column: step.startColumn,
                status: 'running',
                message: 'Step running...'
              });
            } else {
              console.log('Opening file for step (fallback):', sourcePos.filePath);
              await openAndHighlightFile(sourcePos.filePath);
            }
          } else {
            console.log('No source position found in step data');
          }
        });

        // Handle step:success events to update gutter decorations
        agent.emitter.on('step:success', async (data: EventData) => {
          if (data.sourcePosition && data.sourcePosition.filePath) {
            const sourcePos = data.sourcePosition;
            const step = sourcePos.step;

            if (step) {
              const fileUri = vscode.Uri.file(sourcePos.filePath);
              addCommandStatus(fileUri.toString(), {
                line: step.startLine,
                column: step.startColumn,
                status: 'success',
                message: 'Step completed successfully'
              });
            }
          }
        });

        // Handle step:failed events to update gutter decorations
        agent.emitter.on('step:failed', async (data: EventData) => {
          if (data.sourcePosition && data.sourcePosition.filePath) {
            const sourcePos = data.sourcePosition;
            const step = sourcePos.step;

            if (step) {
              const fileUri = vscode.Uri.file(sourcePos.filePath);
              addCommandStatus(fileUri.toString(), {
                line: step.startLine,
                column: step.startColumn,
                status: 'failure',
                message: `Step failed: ${JSON.stringify(data)}`
              });
            }
          }
        });

        // Handle command:start events to open and highlight files
        agent.emitter.on('command:start', async (data: EventData) => {
          console.log('Command started - full data:', JSON.stringify(data, null, 2));

          if (data.sourcePosition && data.sourcePosition.filePath) {
            const sourcePos = data.sourcePosition;
            const command = sourcePos.command;

            if (command) {
                console.log(`[Command:start] Opening file for command: ${sourcePos.filePath}`);
                console.log(`[Command:start] Command details:`, {
                commandIndex: command.commandIndex,
                command: command.command,
                startLine: command.startLine,
                startColumn: command.startColumn,
                endLine: command.endLine,
                endColumn: command.endColumn
                });
                console.log(`[Command:start] SourcePosition:`, sourcePos);
              await openAndHighlightFile(sourcePos.filePath, command.startLine, command.startColumn);

              // Add gutter decoration for running command
              const fileUri = vscode.Uri.file(sourcePos.filePath);
              clearCommandStatuses(fileUri.toString()); // Clear previous statuses for this file
              addCommandStatus(fileUri.toString(), {
                line: command.startLine,
                column: command.startColumn,
                status: 'running',
                message: 'Command running...'
              });
            } else {
              console.log('Opening file for command (fallback):', sourcePos.filePath);
              await openAndHighlightFile(sourcePos.filePath);
            }
          } else {
            console.log('No source position found in command data');
          }
        });

        // Handle command:success events to update gutter decorations
        agent.emitter.on('command:success', async (data: EventData) => {
          if (data.sourcePosition && data.sourcePosition.filePath) {
            const sourcePos = data.sourcePosition;
            const command = sourcePos.command;

            if (command) {
              const fileUri = vscode.Uri.file(sourcePos.filePath);
              addCommandStatus(fileUri.toString(), {
                line: command.startLine,
                column: command.startColumn,
                status: 'success',
                message: 'Command completed successfully'
              });
            }
          }
        });

        // Handle command:progress events which might indicate success
        agent.emitter.on('command:progress', async (data: EventData) => {
          if (data.sourcePosition && data.sourcePosition.filePath) {
            const sourcePos = data.sourcePosition;
            const command = sourcePos.command;

            if (command) {
              // Check if the progress data indicates completion/success
              const progressData = data as { status?: string };
              if (progressData && progressData.status === 'completed') {
                const fileUri = vscode.Uri.file(sourcePos.filePath);
                addCommandStatus(fileUri.toString(), {
                  line: command.startLine,
                  column: command.startColumn,
                  status: 'success',
                  message: 'Command completed successfully'
                });
              }
            }
          }
        });

        // Handle command:failed events to update gutter decorations
        agent.emitter.on('command:failed', async (data: EventData) => {
          if (data.sourcePosition && data.sourcePosition.filePath) {
            const sourcePos = data.sourcePosition;
            const command = sourcePos.command;

            if (command) {
              const fileUri = vscode.Uri.file(sourcePos.filePath);
              addCommandStatus(fileUri.toString(), {
                line: command.startLine,
                column: command.startColumn,
                status: 'failure',
                message: `Command failed: ${JSON.stringify(data)}`
              });
            }
          }
        });

        // Handle file:save events to scroll to the end of the saved file
        agent.emitter.on('file:save', async (data: EventData) => {
          console.log('File save event received:', JSON.stringify(data, null, 2));

          if (data.sourcePosition && data.sourcePosition.filePath) {
            const filePath = data.sourcePosition.filePath;
            console.log('Scrolling to end of saved file:', filePath);

            try {
              // Open the file
              const document = await vscode.workspace.openTextDocument(filePath);

              // Show the document in the editor
              const editor = await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Active,
                preserveFocus: false
              });

              // Scroll to the end of the document
              const lastLine = document.lineCount - 1;
              const lastLineLength = document.lineAt(lastLine).text.length;
              const endPosition = new vscode.Position(lastLine, lastLineLength);

              // Set cursor at the end and reveal it
              editor.selection = new vscode.Selection(endPosition, endPosition);
              editor.revealRange(new vscode.Range(endPosition, endPosition), vscode.TextEditorRevealType.InCenter);

              console.log(`Scrolled to end of file: line ${lastLine + 1}, column ${lastLineLength + 1}`);
            } catch (error) {
              console.error('Failed to scroll to end of saved file:', error);
            }
          } else {
            console.log('No file path found in file:save event data');
          }
        });

        // Handle general error events to update gutter decorations
        agent.emitter.on('error:*', async (errorMessage: string) => {
          if (typeof errorMessage === 'object') {
            errorMessage = JSON.stringify(errorMessage, null, 2);
          }

          // Update decorations to show command failure
          if (agent.sourceMapper && typeof agent.sourceMapper.getCurrentSourcePosition === 'function') {
            const pos = agent.sourceMapper.getCurrentSourcePosition();
            if (pos && pos.filePath) {
              const diagFile = vscode.Uri.file(pos.filePath);

              // Try command position first, then step position
              if (pos.command && diagFile) {
                addCommandStatus(diagFile.toString(), {
                  line: pos.command.startLine,
                  column: pos.command.startColumn,
                  status: 'failure',
                  message: errorMessage
                });
              } else if (pos.step && diagFile) {
                addCommandStatus(diagFile.toString(), {
                  line: pos.step.startLine,
                  column: pos.step.startColumn,
                  status: 'failure',
                  message: errorMessage
                });
              }
            }
          }
        });

        // Handle exit event separately for special processing
        agent.emitter.on('exit', (code: number | null) => {
          console.log('TestDriver agent exited with code:', code);

          // Clear the global agent since it has exited
          globalAgent = null;

          // Restore original working directory
          process.chdir(originalCwd);

          // Send exit event to webview to stop any running spinners
          const webview = 'webview' in panel ? panel.webview : panel;
          webview.postMessage({
            command: 'agentEvent',
            eventName: 'exit',
            data: [code],
            timestamp: Date.now()
          });

          if (!chatEnded) {
            chatEnded = true;
            webview.postMessage({
              command: 'chatResponse'
            });
          }

          if (code !== 0) {
            webview.postMessage({
              command: 'error',
              data: `Chat session ended with exit code ${code}`
            });
            track({
              event: 'chat.session.failed',
              properties: { exitCode: code },
            });
          } else {
            track({
              event: 'chat.session.completed',
            });
          }
        });

        // Load existing file content into executionHistory to append new commands instead of overwriting
        // This mimics what the readline interface does in its start() method
        // We do this AFTER agent.start() and buildEnv() to ensure the agent is fully initialized
        if (fs.existsSync(agent.thisFile)) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const generator = require('testdriverai/agent/lib/generator.js');
            const object = await generator.hydrateFromYML(
              fs.readFileSync(agent.thisFile, 'utf-8'),
            );

            // Push each step to executionHistory from { commands: {steps: [ { commands: [Array] } ] } }
            object.steps?.forEach((step: unknown) => {
              agent.executionHistory.push(step);
            });

            console.log(`Loaded existing test script ${agent.thisFile} with ${object.steps?.length || 0} steps`);
          } catch (error) {
            console.warn('Error loading existing test script:', error);
          }
        }

        // Open the test file being edited (relative to workspace)
        const testFilePath = path.join(workingDir, 'testdriver', 'testdriver.yaml');
        const testFileUri = vscode.Uri.file(testFilePath);

        // Hide terminal when opening test files
        try {
          await vscode.commands.executeCommand('workbench.action.closePanel');
        } catch {
          // Ignore if panel is already closed
        }

        try {
          await openInBottomGroup(testFileUri, {
            preview: false
          });
        } catch (error) {
          console.log('Could not open test file:', error);
          // If file doesn't exist, create it
          try {
            const testDir = path.dirname(testFilePath);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(testDir));
            await vscode.workspace.fs.writeFile(testFileUri, new TextEncoder().encode(''));
            await openInBottomGroup(testFileUri, {
              preview: false
            });
          } catch (createError) {
            console.log('Could not create test file:', createError);
          }
        }

        // Now handle the user message like readline does
        console.log('Processing user message:', userMessage);

        // Clear any previous error counts for new input
        agent.errorCounts = {};
      }

      // Inject environment variables into any ${VAR} strings
      const processedMessage = agent.parser.interpolate(userMessage, agent.config._environment);

      try {
        // Parse interactive commands (starting with /)
        if (processedMessage.startsWith("/")) {
          const parts = processedMessage.slice(1).split(" ");
          const commandName = parts[0];
          const args = parts.slice(1);

          // Parse options (flags starting with --)
          const options: Record<string, string | boolean> = {};
          const cleanArgs: string[] = [];

          for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg.startsWith("--")) {
              // Handle both --flag=value and --flag value formats
              if (arg.includes("=")) {
                // --flag=value format
                const [fullFlag, ...valueParts] = arg.split("=");
                const optName = fullFlag.slice(2);
                const value = valueParts.join("="); // rejoin in case value contains =
                options[optName] = value;
              } else {
                // --flag value format
                const optName = arg.slice(2);
                if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                  options[optName] = args[i + 1];
                  i++; // skip the next argument as it's the value
                } else {
                  options[optName] = true;
                }
              }
            } else {
              cleanArgs.push(arg);
            }
          }

          // Use unified command system like readline does
          await agent.executeUnifiedCommand(commandName, cleanArgs, options);
        } else {
          // Handle regular exploratory input like readline does
          await agent.exploratoryLoop(
            processedMessage.replace(/^\/explore\s+/, ""),
            false,
            true,
            true,
          );
        }

        // Send completion signal to webview (like readline returning to prompt)
        const webview = 'webview' in panel ? panel.webview : panel;
        webview.postMessage({
          command: 'chatResponse'
        });

      } catch (error) {
        console.error('Command error:', error);

        const errorMessage = error instanceof Error ? error.message : String(error);

        const webview = 'webview' in panel ? panel.webview : panel;
        webview.postMessage({
          command: 'error',
          data: `Command error: ${errorMessage}`
        });

        webview.postMessage({
          command: 'chatResponse'
        });
      }

    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Restore original working directory
      process.chdir(originalCwd);

      // Check for API key errors and show popup
      if (errorMessage.includes('API KEY') || errorMessage.includes('API_KEY_MISSING_OR_INVALID')) {
        vscode.window.showErrorMessage(
          'TestDriver: API key missing or invalid. Please set your API key with the "TestDriver: Set API Key" command.',
          'Set API Key'
        ).then(selection => {
          if (selection === 'Set API Key') {
            vscode.commands.executeCommand('testdriver.setApiKey');
          }
        });
      }

      const webview = 'webview' in panel ? panel.webview : panel;
      webview.postMessage({
        command: 'error',
        data: errorMessage
      });

      webview.postMessage({
        command: 'chatResponse'
      });

      track({
        event: 'chat.message.failed',
        properties: { error: errorMessage },
      });
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const webview = 'webview' in panel ? panel.webview : panel;
    webview.postMessage({
      command: 'error',
      data: errorMessage
    });

    webview.postMessage({
      command: 'chatResponse'
    });

    logger.error('Chat message handling failed', err);
    track({
      event: 'chat.message.failed',
      properties: { error: errorMessage },
    });
  }
}
