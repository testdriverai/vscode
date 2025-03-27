import * as vscode from 'vscode';
import { registerSimpleParticipant } from './simple';

export function deactivate() {}

import {
  getContentFromFilesystem,
  TestCase,
  testData,
  TestFile,
} from './testTree';

export async function activate(context: vscode.ExtensionContext) {
  registerSimpleParticipant(context);

  const ctrl = vscode.tests.createTestController(
    'mathTestController',
    'Markdown Math',
  );
  context.subscriptions.push(ctrl);

  const fileChangedEmitter = new vscode.EventEmitter<vscode.Uri>();
  const watchingTests = new Map<
    vscode.TestItem | 'ALL',
    vscode.TestRunProfile | undefined
  >();
  fileChangedEmitter.event((uri) => {
    if (watchingTests.has('ALL')) {
      startTestRun(
        new vscode.TestRunRequest(
          undefined,
          undefined,
          watchingTests.get('ALL'),
          true,
        ),
      );
      return;
    }

    const include: vscode.TestItem[] = [];
    let profile: vscode.TestRunProfile | undefined;
    for (const [item, thisProfile] of watchingTests) {
      const cast = item as vscode.TestItem;
      if (cast.uri?.toString() == uri.toString()) {
        include.push(cast);
        profile = thisProfile;
      }
    }

    if (include.length) {
      startTestRun(
        new vscode.TestRunRequest(include, undefined, profile, true),
      );
    }
  });

  async function runHandler(
    shouldDebug: boolean,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ) {
    const run = controller.createTestRun(request);
    const queue: vscode.TestItem[] = [];

    // Loop through all included tests, or all known tests, and add them to our queue
    if (request.include) {
      request.include.forEach((test) => queue.push(test));
    } else {
      controller.items.forEach((test) => queue.push(test));
    }

    // For every test that was queued, try to run it. Call run.passed() or run.failed().
    // The `TestMessage` can contain extra information, like a failing location or
    // a diff output. But here we'll just give it a textual message.
    while (queue.length > 0 && !token.isCancellationRequested) {
      const test = queue.pop()!;

      // Skip tests the user asked to exclude
      if (request.exclude?.includes(test)) {
        continue;
      }

      switch (getType(test)) {
        case ItemType.File:
          // If we're running a file and don't know what it contains yet, parse it now
          if (test.children.size === 0) {
            await parseTestsInFileContents(test);
          }
          break;
        case ItemType.TestCase:
          // Otherwise, just run the test case. Note that we don't need to manually
          // set the state of parent tests; they'll be set automatically.
          const start = Date.now();
          try {
            await assertTestPasses(test);
            run.passed(test, Date.now() - start);
          } catch (e) {
            run.failed(
              test,
              new vscode.TestMessage(e.message),
              Date.now() - start,
            );
          }
          break;
      }

      test.children.forEach((test) => queue.push(test));
    }

    // Make sure to end the run after all tests have been executed:
    run.end();
  }

  const startTestRun = (request: vscode.TestRunRequest) => {
    const queue: { test: vscode.TestItem; data: TestCase }[] = [];
    const run = ctrl.createTestRun(request);
    // map of file uris to statements on each line:
    const coveredLines = new Map<
      /* file uri */ string,
      (vscode.StatementCoverage | undefined)[]
    >();

    const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
      for (const test of tests) {
        if (request.exclude?.includes(test)) {
          continue;
        }

        const data = testData.get(test);
        if (data instanceof TestCase) {
          run.enqueued(test);
          queue.push({ test, data });
        } else {
          if (data instanceof TestFile && !data.didResolve) {
            await data.updateFromDisk(ctrl, test);
          }

          await discoverTests(gatherTestItems(test.children));
        }

        if (
          test.uri &&
          !coveredLines.has(test.uri.toString()) &&
          request.profile?.kind === vscode.TestRunProfileKind.Coverage
        ) {
          try {
            const lines = (await getContentFromFilesystem(test.uri)).split(
              '\n',
            );
            coveredLines.set(
              test.uri.toString(),
              lines.map((lineText, lineNo) =>
                lineText.trim().length
                  ? new vscode.StatementCoverage(
                      0,
                      new vscode.Position(lineNo, 0),
                    )
                  : undefined,
              ),
            );
          } catch {
            // ignored
          }
        }
      }
    };

    const runTestQueue = async () => {
      for (const { test, data } of queue) {
        run.appendOutput(`Running ${test.id}\r\n`);

        if (run.token.isCancellationRequested) {
          run.skipped(test);
        } else {
          run.started(test);
          await data.run(test, run);
        }

        const lineNo = test.range!.start.line;
        const fileCoverage = coveredLines.get(test.uri!.toString());
        const lineInfo = fileCoverage?.[lineNo];

        if (lineInfo) {
          (lineInfo.executed as number)++;
        }

        run.appendOutput(`Completed ${test.id}\r\n`);
      }

      for (const [uri, statements] of coveredLines) {
        run.addCoverage(new MarkdownFileCoverage(uri, statements));
      }

      run.end();
    };

    discoverTests(request.include ?? gatherTestItems(ctrl.items)).then(
      runTestQueue,
    );
  };

  ctrl.refreshHandler = async () => {
    await Promise.all(
      getWorkspaceTestPatterns().map(({ pattern }) =>
        findInitialFiles(ctrl, pattern),
      ),
    );
  };

  ctrl.createRunProfile(
    'Run Tests',
    vscode.TestRunProfileKind.Run,
    runHandler,
    true,
    undefined,
    true,
  );

  const coverageProfile = ctrl.createRunProfile(
    'Run with Coverage',
    vscode.TestRunProfileKind.Coverage,
    runHandler,
    true,
    undefined,
    true,
  );
  coverageProfile.loadDetailedCoverage = async (_testRun, coverage) => {
    if (coverage instanceof MarkdownFileCoverage) {
      return coverage.coveredLines.filter(
        (l): l is vscode.StatementCoverage => !!l,
      );
    }

    return [];
  };

  ctrl.resolveHandler = async (item) => {
    if (!item) {
      context.subscriptions.push(
        ...startWatchingWorkspace(ctrl, fileChangedEmitter),
      );
      return;
    }

    const data = testData.get(item);
    if (data instanceof TestFile) {
      await data.updateFromDisk(ctrl, item);
    }
  };

  function updateNodeForDocument(e: vscode.TextDocument) {
    if (e.uri.scheme !== 'file') {
      return;
    }

    if (!e.uri.path.endsWith('.yaml')) {
      return;
    }

    const { file, data } = getOrCreateFile(ctrl, e.uri);
    data.updateFromContents(ctrl, e.getText(), file);
  }

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidChangeTextDocument((e) =>
      updateNodeForDocument(e.document),
    ),
  );
}

function getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri) {
  const existing = controller.items.get(uri.toString());
  if (existing) {
    return { file: existing, data: testData.get(existing) as TestFile };
  }

  const file = controller.createTestItem(
    uri.toString(),
    uri.path.split('/').pop()!,
    uri,
  );
  controller.items.add(file);

  const data = new TestFile();
  testData.set(file, data);

  file.canResolveChildren = true;
  return { file, data };
}

function gatherTestItems(collection: vscode.TestItemCollection) {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => items.push(item));
  return items;
}

function getWorkspaceTestPatterns() {
  if (!vscode.workspace.workspaceFolders) {
    return [];
  }

  return vscode.workspace.workspaceFolders.map((workspaceFolder) => ({
    workspaceFolder,
    pattern: new vscode.RelativePattern(
      workspaceFolder,
      'testdriver/**/*.yaml',
    ),
  }));
}

async function findInitialFiles(
  controller: vscode.TestController,
  pattern: vscode.GlobPattern,
) {
  for (const file of await vscode.workspace.findFiles(pattern)) {
    getOrCreateFile(controller, file);
  }
}

function startWatchingWorkspace(
  controller: vscode.TestController,
  fileChangedEmitter: vscode.EventEmitter<vscode.Uri>,
) {
  return getWorkspaceTestPatterns().map(({ pattern }) => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate((uri) => {
      getOrCreateFile(controller, uri);
      fileChangedEmitter.fire(uri);
    });
    watcher.onDidChange(async (uri) => {
      const { file, data } = getOrCreateFile(controller, uri);
      if (data.didResolve) {
        await data.updateFromDisk(controller, file);
      }
      fileChangedEmitter.fire(uri);
    });
    watcher.onDidDelete((uri) => controller.items.delete(uri.toString()));

    findInitialFiles(controller, pattern);

    return watcher;
  });
}

class MarkdownFileCoverage extends vscode.FileCoverage {
  constructor(
    uri: string,
    public readonly coveredLines: (vscode.StatementCoverage | undefined)[],
  ) {
    super(vscode.Uri.parse(uri), new vscode.TestCoverageCount(0, 0));
    for (const line of coveredLines) {
      if (line) {
        this.statementCoverage.covered += line.executed ? 1 : 0;
        this.statementCoverage.total++;
      }
    }
  }
}
