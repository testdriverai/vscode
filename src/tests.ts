import * as vscode from 'vscode';
import path from 'path';
import { track, logger } from './utils/logger';
import { TestDiagnostics } from './utils/diagnostics';
import {
  initializeDecorations,
  disposeDecorations,
  addCommandStatus,
  clearCommandStatuses,
  registerDecorationUpdates
} from './utils/decorations';

import { beautifyFilename, getUri } from './utils/helpers';
import { openTestDriverWebview } from './utils/webview';

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

const FLAT = false;
const testGlobPattern = 'testdriver/**/*.{yml,yaml}';

let sharedController: vscode.TestController | undefined;
let sharedContext: vscode.ExtensionContext | undefined;
export const setupTests = (context?: vscode.ExtensionContext) => {
  if (context) {
    sharedContext = context;

    // Initialize decorations
    initializeDecorations(context);
    registerDecorationUpdates();

    // Dispose decorations when extension is deactivated
    context.subscriptions.push({
      dispose: disposeDecorations
    });
  }
  if (!sharedController) {
    sharedController = vscode.tests.createTestController(
      'testdriver-test-controller',
      'TestDriver',
    );
    discoverAndWatchTests(sharedController);
    setupRunProfiles(sharedController, sharedContext);
  }
  return sharedController;
};

const discoverAndWatchTests = async (controller: vscode.TestController) => {
  if (!vscode.workspace.workspaceFolders) {
    return [];
  }
  vscode.workspace.workspaceFolders.map(async (workspaceFolder) => {
    const pattern = new vscode.RelativePattern(
      workspaceFolder,
      testGlobPattern,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const refresh = () => refreshTests(controller, workspaceFolder);

    watcher.onDidCreate(refresh);
    watcher.onDidDelete(refresh);
    refresh();
  });
};

const refreshTests = async (
  controller: vscode.TestController,
  workspaceFolder: vscode.WorkspaceFolder,
) => {
  const pattern = new vscode.RelativePattern(workspaceFolder, testGlobPattern);
  const matches = await vscode.workspace.findFiles(pattern);
  const filteredMatches = matches
    .map((uri) => ({
      uri,
      parts: vscode.workspace
        .asRelativePath(uri, false)
        .replace(/^testdriver\/?/, '')
        .split('/'),
    }))
    .filter(({ parts }) => {
      return !['', 'screenshots'].includes(parts[0]);
    });

  controller.items.forEach((item) => {
    controller.items.delete(item.id);
  });

  if (FLAT) {
    filteredMatches.forEach(({ uri: file }) => {
      controller.items.add(
        controller.createTestItem(
          file.toString(),
          beautifyFilename(file.toString()),
          file,
        ),
      );
    });
  } else {
    const testFiles = filteredMatches.map(({ parts }) =>
      parts.map((_, index) => parts.slice(0, index + 1).join('/')),
    );

    for (const test of testFiles) {
      let cursor = controller.items;
      for (const path of test) {
        const uri = getUri(`testdriver/${path}`, workspaceFolder);
        const id = uri.toString();
        if (!cursor.get(id)) {
          cursor.add(
            controller.createTestItem(id, beautifyFilename(path), uri),
          );
        }

        cursor = cursor.get(id)!.children;
      }
    }
  }
};

// Store test run flags in memory (could be persisted in globalState if needed)

const setupRunProfiles = (controller: vscode.TestController, context?: vscode.ExtensionContext) => {

  async function runHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ) {
    const run = controller.createTestRun(request);
    track({ event: 'test.run.start' });
    let runEnded = false;

    const queue: vscode.TestItem[] = [];
    const addToQueue = (test: vscode.TestItem) => {
      if (request.exclude?.includes(test)) {
        return;
      }
      track({
        event: 'test.item.queued',
        properties: { id: test.id, path: test.uri?.fsPath },
      });
      queue.push(test);
      run.enqueued(test);
    };

    if (request.include?.length) {
      request.include.forEach((test) => addToQueue(test));
    } else {
      controller.items.forEach((test) => addToQueue(test));
    }

    token.onCancellationRequested(() => {
      track({ event: 'test.run.canceled' });
      // End the test run immediately when cancelled to stop the spinner
      if (!runEnded) {
        runEnded = true;
        run.end();
      }
    });

    // Collect all leaf test items (those without children)
    const leafTests: vscode.TestItem[] = [];
    const collectLeafTests = (test: vscode.TestItem) => {
      if (test.children.size === 0) {
        leafTests.push(test);
      } else {
        test.children.forEach((child) => collectLeafTests(child));
      }
    };

    queue.forEach((test) => collectLeafTests(test));

    // Run all tests in parallel
    const testPromises = leafTests.map(async (test) => {

      if (token.isCancellationRequested) {
        return;
      }

      run.started(test);
      const workspaceFolder = vscode.workspace.workspaceFolders!.find((ws) =>
        test.uri?.fsPath.startsWith(ws.uri.fsPath),
      )!;

      // Declare agent variable that will be set later
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let agent: any;
      let testKilledByUser = false;
      const originalCwd: string = process.cwd();

      // Register cancellation handler to destroy the agent and fail the test
      const cancelListener = token.onCancellationRequested(() => {

        testKilledByUser = true;

        console.log(`Test run cancelled for ${test.id}`);
        run.appendOutput(`Test run cancelled for ${test.id}\r\n`, undefined, test);

        if (agent && agent.exit) {
          try {
            agent.exit(false);
          } catch (e) {
            logger.error('Error destroying TestDriver agent on cancel', e);
          }
        }
        // Mark the test as failed if killed by user
        run.failed(test, new vscode.TestMessage('Test run was cancelled by the user.'));
        track({
          event: 'test.item.failed',
          properties: { id: test.id, path: test.uri?.fsPath, reason: 'cancelled' },
        });
      });

      // Clear diagnostics for this test file before running
      if (test.uri) {
        TestDiagnostics.clear(test.uri);
        // Clear previous command status decorations
        clearCommandStatuses(test.uri.toString());
      }

      try {
        await new Promise<void>((resolve) => {
          // Initialize the TestDriver agent directly
          (async () => {
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
              run.failed(test, new vscode.TestMessage('Test failed: API key is required'));
              track({
                event: 'test.item.failed',
                properties: { id: test.id, path: test.uri?.fsPath, reason: 'no-api-key' },
              });
              resolve();
              return;
            }

            // Change process working directory to the workspace folder containing the test file
            process.chdir(workspaceFolder.uri.fsPath);

            // Prepare environment variables for the agent
            const agentEnvironment = {
              TD_API_KEY: apiKey,
              ...process.env // Include other environment variables
            };

            // Set working directory to the workspace folder containing the test file
            const workingDir = workspaceFolder.uri.fsPath;

            // Set the file path - use relative path from git root within testdriver folder
            console.log('Test URI:', test.uri?.toString());
            console.log('Test URI fsPath:', test.uri?.fsPath);

            if (!test.uri) {
              throw new Error('Test URI is undefined');
            }

            const relativePath = vscode.workspace.asRelativePath(test.uri, false);
            console.log('Relative path:', relativePath);

            let finalPath: string;
            if (!relativePath || relativePath === test.uri.fsPath) {
              // Fallback: if asRelativePath doesn't work, manually create the relative path
              const testPath = test.uri.fsPath;
              const workspacePath = workspaceFolder.uri.fsPath;
              if (testPath.startsWith(workspacePath)) {
                const manualRelativePath = path.relative(workspacePath, testPath);
                console.log('Using manual relative path:', manualRelativePath);
                console.log('Manual relative path (normalized):', manualRelativePath.replace(/\\/g, '/'));
                // Use the manual relative path, ensuring forward slashes
                finalPath = manualRelativePath.replace(/\\/g, '/');
              } else {
                throw new Error(`Test file ${testPath} is not within workspace ${workspacePath}`);
              }
            } else {
              finalPath = relativePath;
            }

            // Set up CLI args for the agent
            // Based on CLI structure: npx testdriverai@latest run path/to/test.yaml
            // The agent constructor expects CLI args that mimic the actual command line structure
            const cliArgs = {
              command: 'run',
              args: [finalPath], // Include 'run' as first arg, then the file path
              options: {
                workingDir: workingDir,
                new: true
              },
            };

            console.log('CLI args being passed to agent:', JSON.stringify(cliArgs, null, 2));

            // Create agent with environment and CLI args
            agent = new TestDriverAgent(agentEnvironment, cliArgs);

            // Manually set thisFile if the agent didn't derive it correctly
            if (!agent.thisFile && finalPath) {
              console.log('Agent thisFile is null, manually setting to:', finalPath);
              agent.thisFile = finalPath;
            }

            console.log('Created agent with configuration:', {
              environment: agentEnvironment.TD_API_KEY ? 'API key present' : 'No API key',
              workingDir: workingDir,
              thisFile: finalPath,
              agentThisFile: agent.thisFile,
              agentWorkingDir: agent.workingDir,
              agentCliArgs: agent.cliArgs
            });

            // Create output channel for TestDriver debugging
            const outputChannel = vscode.window.createOutputChannel('TestDriver Debug');

            // General event logging for debugging
            agent.emitter.on('**', (data: unknown) => {
                let message: string;
                if (typeof data === 'string' && typeof data.replace === 'function') {
                  message = data.replace(/\n/g, '\r\n');
                } else if (typeof data === 'object') {
                  message = JSON.stringify(data, null, 2).replace(/\n/g, '\r\n');
                } else {
                  message = String(data);
                }

                outputChannel.appendLine(`[${agent.emitter.event}] ${message}`);
              });

            // Allow any type for message
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sendToSandbox = (message: any) => {
              // ensure message is a string
              if (typeof message !== "string") {
              message = JSON.stringify(message);
              }
              agent.sandbox.send({
              type: "output",
              output: Buffer.from(message).toString("base64"),
              });
            };

            // Handle sandbox connection with pattern matching for subsequent events
            agent.emitter.on("sandbox:connected", () => {
              // Once sandbox is connected, send all log and error events to sandbox
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              agent.emitter.on("log:*", (message: any) => {
              sendToSandbox(message);
              });

              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              agent.emitter.on("error:*", (message: any) => {
              sendToSandbox(message);
              });
            });

            // Listen to events from the agent's emitter
            agent.emitter.on('log:*', (data: string) => {

                let message: string;
                if (typeof data === 'string' && typeof data.replace === 'function') {
                  message = data.replace(/\n/g, '\r\n');
                } else if (typeof data === 'object') {
                  message = JSON.stringify(data, null, 2).replace(/\n/g, '\r\n');
                } else {
                  message = String(data);
                }

                // Try to get the location from the current command if available
                let location: vscode.Location | undefined = undefined;
                if (
                agent.sourceMapper &&
                typeof agent.sourceMapper.getCurrentSourcePosition === 'function'
                ) {
                const pos = agent.sourceMapper.getCurrentSourcePosition();
                if (pos && pos.command) {
                  const diagFile = (pos.filePath)
                  ? vscode.Uri.file(pos.filePath)
                  : test.uri;
                  if (diagFile) {
                  location = new vscode.Location(
                    diagFile,
                    new vscode.Range(
                    pos.command.startLine,
                    pos.command.startColumn,
                    pos.command.endLine,
                    pos.command.endColumn
                    )
                  );
                  }
                }
                }
                run.appendOutput(
                `${message}\r\n`,
                location,
                test
                );
            });

            // Listen for command status events to update gutter decorations
            agent.emitter.on('command:start', (_data: unknown) => {
              if (test.uri && agent.sourceMapper && typeof agent.sourceMapper.getCurrentSourcePosition === 'function') {
                const pos = agent.sourceMapper.getCurrentSourcePosition();
                // Prefer pos.file if available, otherwise fall back to test.uri
                const diagFile = (pos && pos.filePath)
                  ? vscode.Uri.file(pos.filePath)
                  : test.uri;
                if (pos && pos.command && diagFile) {
                  addCommandStatus(diagFile.toString(), {
                    line: pos.command.startLine,
                    column: pos.command.startColumn,
                    status: 'running',
                    message: 'Command running...'
                  });
                }
              }
            });

            agent.emitter.on('command:success', (_data: unknown) => {
              if (test.uri && agent.sourceMapper && typeof agent.sourceMapper.getCurrentSourcePosition === 'function') {
                const pos = agent.sourceMapper.getCurrentSourcePosition();
                // Prefer pos.file if available, otherwise fall back to test.uri
                const diagFile = (pos && pos.filePath)
                  ? vscode.Uri.file(pos.filePath)
                  : test.uri;
                if (pos && pos.command && diagFile) {
                  addCommandStatus(diagFile.toString(), {
                    line: pos.command.startLine,
                    column: pos.command.startColumn,
                    status: 'success',
                    message: 'Command completed successfully'
                  });
                }
              }
            });

            // Also listen for command:progress which indicates success in some cases
            agent.emitter.on('command:progress', (data: unknown) => {
              if (test.uri && agent.sourceMapper && typeof agent.sourceMapper.getCurrentSourcePosition === 'function') {
                const pos = agent.sourceMapper.getCurrentSourcePosition();
                // Prefer pos.file if available, otherwise fall back to test.uri
                const diagFile = (pos && pos.filePath)
                  ? vscode.Uri.file(pos.filePath)
                  : test.uri;
                if (pos && pos.command && diagFile) {
                  // Check if the progress data indicates completion/success
                  const progressData = data as { status?: string };
                  if (progressData && progressData.status === 'completed') {
                    addCommandStatus(diagFile.toString(), {
                      line: pos.command.startLine,
                      column: pos.command.startColumn,
                      status: 'success',
                      message: 'Command completed successfully'
                    });
                  }
                }
              }
            });

            // Listen for command errors/failures
            agent.emitter.on('command:failed', (data: unknown) => {
              if (test.uri && agent.sourceMapper && typeof agent.sourceMapper.getCurrentSourcePosition === 'function') {
                const pos = agent.sourceMapper.getCurrentSourcePosition();
                // Prefer pos.file if available, otherwise fall back to test.uri
                const diagFile = (pos && pos.filePath)
                  ? vscode.Uri.file(pos.filePath)
                  : test.uri;
                if (pos && pos.command && diagFile) {
                  addCommandStatus(diagFile.toString(), {
                    line: pos.command.startLine,
                    column: pos.command.startColumn,
                    status: 'failure',
                    message: `Command failed: ${JSON.stringify(data)}`
                  });
                }
              }
            });

            // Add debug logging for API key related events
            agent.emitter.on('**', (data: unknown) => {
              const event = agent.emitter.event;
              if (event && (event.includes('api') || event.includes('key') || event.includes('auth'))) {
                console.log('API-related event:', event, data);
              }
              logger.info(agent.emitter.event, data);
            });

            // Listen for show-window event to open TestDriver webview
            agent.emitter.on('show-window', async (url: string) => {
                // Use the test file name as the webview title
                const testFileName = test.label || 'TestDriver';

                await openTestDriverWebview(context!, url, `${testFileName} - TestDriver`);

            });

            agent.emitter.on('exit', (code: number | null) => {

              console.log('TestDriver agent exited with code:', code);

              // Restore original working directory
              process.chdir(originalCwd);

              if (testKilledByUser) {
                // Already marked as failed in cancel handler
                resolve();
                return;
              }
              if (code !== 0) {
                run.failed(test, new vscode.TestMessage(`Test failed with exit code ${code}`));
                track({
                  event: 'test.item.failed',
                  properties: { id: test.id, path: test.uri?.fsPath },
                });
              } else {
                track({
                  event: 'test.item.passed',
                  properties: { id: test.id, path: test.uri?.fsPath },
                });
                run.passed(test);
              }
              resolve();
            });

            agent.emitter.on('error:*', async (errorMessage: string) => {

              if (typeof errorMessage == 'object') {
                errorMessage = JSON.stringify(errorMessage, null, 2);
              }

              run.appendOutput(errorMessage.replace(/\n/g, '\r\n') + '\r\n', undefined, test);

              // Update decorations to show command failure
              if (test.uri && agent.sourceMapper && typeof agent.sourceMapper.getCurrentSourcePosition === 'function') {
                const pos = agent.sourceMapper.getCurrentSourcePosition();
                // Prefer pos.file if available, otherwise fall back to test.uri
                const diagFile = (pos && pos.filePath)
                  ? vscode.Uri.file(pos.filePath)
                  : test.uri;
                if (pos && pos.command && diagFile) {
                  addCommandStatus(diagFile.toString(), {
                    line: pos.command.startLine,
                    column: pos.command.startColumn,
                    status: 'failure',
                    message: errorMessage
                  });
                }
              }

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

              // Restore original working directory
              process.chdir(originalCwd);

              resolve();

                // Try to get error position from agent/source-mapper if available
                // Strip ANSI codes from errorMessage before using it
                const { default: stripAnsi } = await import('strip-ansi');
                const cleanErrorMessage = stripAnsi(errorMessage);

                let diagnostic;
                if (agent && agent.sourceMapper && typeof agent.sourceMapper.getCurrentSourcePosition === 'function') {
                const pos = agent.sourceMapper.getCurrentSourcePosition();
                // Prefer pos.file if available, otherwise fall back to test.uri
                const diagFile = (pos && pos.filePath)
                  ? vscode.Uri.file(pos.filePath)
                  : test.uri;
                if (pos && diagFile) {
                  let range;
                  if (pos.command) {
                  range = new vscode.Range(pos.command.startLine, pos.command.startColumn, pos.command.endLine, pos.command.endColumn);
                  } else if (pos.step) {
                  range = new vscode.Range(pos.step.startLine, pos.step.startColumn, pos.step.endLine, pos.step.endColumn);
                  }
                  if (range) {
                  diagnostic = new vscode.Diagnostic(
                    range,
                    cleanErrorMessage,
                    vscode.DiagnosticSeverity.Error
                  );
                  TestDiagnostics.set(diagFile, [diagnostic]);
                  }
                }
                }
            });

            // Start the agent
            console.log('Starting agent with configuration:', {
              environment: agentEnvironment.TD_API_KEY ? 'API key present' : 'No API key',
              workingDir: agent.workingDir,
              thisFile: agent.thisFile
            });
            await agent.start();
          })();
        });
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

        // Try to get error position from agent/source-mapper if available
        let diagnostic;
        if (agent && agent.sourceMapper && typeof agent.sourceMapper.getCurrentSourcePosition === 'function') {
          const pos = agent.sourceMapper.getCurrentSourcePosition();
          // Prefer pos.file if available, otherwise fall back to test.uri
          const diagFile = (pos && pos.filePath)
            ? vscode.Uri.file(pos.filePath)
            : test.uri;
          if (pos && diagFile) {
            let range;
            if (pos.command) {
              range = new vscode.Range(pos.command.startLine, pos.command.startColumn, pos.command.endLine, pos.command.endColumn);
            } else if (pos.step) {
              range = new vscode.Range(pos.step.startLine, pos.step.startColumn, pos.step.endLine, pos.step.endColumn);
            }
            if (range) {
              diagnostic = new vscode.Diagnostic(
                range,
                errorMessage,
                vscode.DiagnosticSeverity.Error
              );
              TestDiagnostics.set(diagFile, [diagnostic]);
            }
          }
        }
        run.failed(test, new vscode.TestMessage(errorMessage));
        track({
          event: 'test.item.failed',
          properties: { id: test.id, path: test.uri?.fsPath },
        });
      } finally {
        logger.info(`Test ${test.id} finished`);
        cancelListener.dispose();
      }
    });

    // Wait for all tests to complete
    await Promise.all(testPromises);

    // Make sure to end the run after all tests have been executed (if not already ended due to cancellation):
    if (!runEnded) {
      runEnded = true;
      run.end();
    }
    track({
      event: 'test.run.end',
    });
  }

  controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    (request, token) =>  runHandler(request, token)
  );
};
