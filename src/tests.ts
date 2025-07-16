import * as vscode from 'vscode';
import { TDInstance } from './cli';
import { track, logger } from './utils/logger';
import { TestDiagnostics } from './utils/diagnostics';

import { beautifyFilename, getUri } from './utils/helpers';

const FLAT = false;
const testGlobPattern = 'testdriver/**/*.{yml,yaml}';

let sharedController: vscode.TestController | undefined;
let sharedContext: vscode.ExtensionContext | undefined;
export const setupTests = (context?: vscode.ExtensionContext) => {
  if (context) {
    sharedContext = context;
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
      return !['', 'lifecycle', 'screenshots'].includes(parts[0]);
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

      const relativePath = vscode.workspace.asRelativePath(test.uri!, false);

      let instance: TDInstance | undefined;
      const abortController = new AbortController();
      let testKilledByUser = false;

      // Register cancellation handler to destroy the TDInstance and fail the test
      const cancelListener = token.onCancellationRequested(() => {
        abortController.abort();
        testKilledByUser = true;
        if (instance && typeof instance.destroy === 'function') {
          try {
            instance.destroy();
          } catch (e) {
            logger.error('Error destroying TDInstance on cancel', e);
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
      }

      try {
        await new Promise<void>((resolve) => {
          // Compose params with selected flags
          // params removed, now using command/flags in TDInstance
          instance = new TDInstance(workspaceFolder.uri.fsPath, {
            focus: false,
            command: 'run',
            file: relativePath,
            context,
          });

          // Listen to events from the TDInstance emitter
          instance.on('log:log', (data: string) => {
            console.log('appending output', data);
            run.appendOutput(data + '\r\n', undefined, test);
          });
          instance.on('exit', (code: number | null) => {
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
          instance.on('error:fatal', (data: string) => {
            run.appendOutput(data + '\r\n', undefined, test);

              // Try to get error position from agent/source-mapper if available
              let diagnostic;
              if (instance && instance.agent && instance.agent.sourceMapper && typeof instance.agent.sourceMapper.getCurrentSourcePosition === 'function') {
                const pos = instance.agent.sourceMapper.getCurrentSourcePosition();
                // Prefer pos.file if available, otherwise fall back to test.uri
                console.log('pos', pos);
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
                      `Test failed: ${test.label}`,
                      vscode.DiagnosticSeverity.Error
                    );
                    TestDiagnostics.set(diagFile, [diagnostic]);
                  }
                }
              }
          });
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        // Try to get error position from agent/source-mapper if available
        let diagnostic;
        if (instance && instance.agent && instance.agent.sourceMapper && typeof instance.agent.sourceMapper.getCurrentSourcePosition === 'function') {
          const pos = instance.agent.sourceMapper.getCurrentSourcePosition();
          // Prefer pos.file if available, otherwise fall back to test.uri
          const diagFile = (pos && pos.file)
            ? vscode.Uri.file(pos.file)
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

    // Make sure to end the run after all tests have been executed:
    run.end();
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
