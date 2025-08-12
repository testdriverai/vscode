import * as vscode from 'vscode';
import * as path from 'path';
import { createChatWebview } from '../utils/chatWebview';
import { openTestDriverWebview } from '../utils/webview';
import { track, logger } from '../utils/logger';

// Import dotenv to load environment variables
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dotenv = require('dotenv');

// Import the TestDriver agent directly from the package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestDriverAgent = require('testdriverai');

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

export function registerChatCommand(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('testdriver.openChat', async () => {
    track({ event: 'chat.opened' });

    const panel = createChatWebview(context);

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.command) {
          case 'sendMessage':
            await handleChatMessage(message.message, panel, context);
            break;
        }
      },
      undefined,
      context.subscriptions
    );
  });

  context.subscriptions.push(disposable);
}

export { handleChatMessage };

async function handleChatMessage(userMessage: string, panel: vscode.WebviewPanel | vscode.WebviewView, context: vscode.ExtensionContext) {
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
      const cliArgs = {
        command: 'edit',
        args: ['testdriver/testdriver.yaml'], // Use relative path from workspace root
        options: {
          new: true
        },
      };

      console.log('CLI args being passed to agent:', JSON.stringify(cliArgs, null, 2));

      // Create agent with environment and CLI args
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent: any = new TestDriverAgent(agentEnvironment, cliArgs);

      console.log('Created agent with configuration:', {
        environment: agentEnvironment.TD_API_KEY ? 'API key present' : 'No API key',
        workingDir: workingDir,
        agentWorkingDir: agent.workingDir,
        agentCliArgs: agent.cliArgs
      });

      // Track that we're running a chat session
      let chatEnded = false;

      // Unified event forwarding - listen to all events and forward them to webview
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent.emitter.onAny((eventName: string, ...args: any[]) => {
        console.log('Received agent event:', eventName, args);

        const webview = 'webview' in panel ? panel.webview : panel;
        webview.postMessage({
          command: 'agentEvent',
          eventName: eventName,
          data: args,
          timestamp: Date.now()
        });
      });

      // Handle exit event separately for special processing
      agent.emitter.on('exit', (code: number | null) => {
        console.log('TestDriver agent exited with code:', code);

        // Restore original working directory
        process.chdir(originalCwd);

        if (!chatEnded) {
          chatEnded = true;
          const webview = 'webview' in panel ? panel.webview : panel;
          webview.postMessage({
            command: 'chatResponse'
          });
        }

        if (code !== 0) {
          const webview = 'webview' in panel ? panel.webview : panel;
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

      // Handle show-window event to open TestDriver webview instead of external browser
      agent.emitter.on('show-window', async (url: string) => {
        // Use the test file name as the webview title
        const testFileName = 'TestDriver Session';
        await openTestDriverWebview(url, `${testFileName} - TestDriver`);
      });

      // Start the agent first
      console.log('Starting agent...');
      await agent.start();

      // Build the environment (sandbox) for interactive mode
      console.log('Building environment...');
      await agent.buildEnv({ new: true });

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
        await vscode.window.showTextDocument(testFileUri, {
          viewColumn: vscode.ViewColumn.Two, // Open below the VM window
          preview: false
        });
      } catch (error) {
        console.log('Could not open test file:', error);
        // If file doesn't exist, create it
        try {
          const testDir = path.dirname(testFilePath);
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(testDir));
          await vscode.workspace.fs.writeFile(testFileUri, new TextEncoder().encode(''));
          await vscode.window.showTextDocument(testFileUri, {
            viewColumn: vscode.ViewColumn.Two, // Open below the VM window
            preview: false
          });
        } catch (createError) {
          console.log('Could not create test file:', createError);
        }
      }

      // Now send the user message as an exploratory prompt
      // This is like what the readline interface does for non-command input
      console.log('Sending user message to exploratory loop:', userMessage);
      await agent.exploratoryLoop(userMessage, false, true, true);

      // The agent will continue running and emitting events
      // The conversation is complete when the agent finishes processing

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
