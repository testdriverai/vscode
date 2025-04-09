import * as vscode from 'vscode';
import { TDInstance } from './cli';
import { beautifyFilename, getUri } from './utils';

const FLAT = false;
const testGlobPattern = 'testdriver/**/*.{yml,yaml}';

export const setupTests = () => {
  const controller = vscode.tests.createTestController(
    'testdriver-test-controller',
    'TestDriver',
  );
  discoverAndWatchTests(controller);
  setupRunProfiles(controller);

  return controller;
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
      return !['', 'generate', 'screenshots'].includes(parts[0]);
      // && !/\.tmp\.ya?ml$/i.test(parts[parts.length - 1])
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

const setupRunProfiles = (controller: vscode.TestController) => {
  async function runHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ) {
    const run = controller.createTestRun(request);
    const queue: vscode.TestItem[] = [];
    const addToQueue = (test: vscode.TestItem) => {
      if (request.exclude?.includes(test)) {
        return;
      }
      queue.push(test);
      run.enqueued(test);
    };

    if (request.include?.length) {
      request.include.forEach((test) => addToQueue(test));
    } else {
      controller.items.forEach((test) => addToQueue(test));
    }

    while (queue.length > 0 && !token.isCancellationRequested) {
      const test = queue.pop()!;

      if (test.children.size === 0) {
        run.started(test);
        const workspaceFolder = vscode.workspace.workspaceFolders!.find((ws) =>
          test.uri?.fsPath.startsWith(ws.uri.fsPath),
        )!;

        const relativePath = vscode.workspace.asRelativePath(test.uri!, false);
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        const instance = new TDInstance(workspaceFolder.uri.fsPath);
        instance.on('stdout', (data) => {
          run.appendOutput(data.replace(/(?<!\r)\n/g, '\r\n'), undefined, test);
        });
        instance.on('stderr', (data) => {
          run.appendOutput(data.replace(/(?<!\r)\n/g, '\r\n'), undefined, test);
        });

        await instance
          .run(`/run ${relativePath}`, {
            signal: abortController.signal,
          })
          .then(() => run.passed(test))
          .catch((err) => run.failed(test, new vscode.TestMessage(err.message)))
          .finally(() => instance.destroy());

        console.log(`Test ${test.id} finished`);
      } else {
        test.children.forEach((test) => addToQueue(test));
      }
    }

    // Make sure to end the run after all tests have been executed:
    run.end();
  }

  controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    (request, token) => runHandler(request, token),
  );
};
