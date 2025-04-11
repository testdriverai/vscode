import yaml from 'js-yaml';
import * as vscode from 'vscode';
import SourceMap from 'js-yaml-source-map';
import { types } from './spec';
import { getTestInstance } from './cli';
import { getUri, unslugify, asyncFilter } from './utils';

const FLAT = true;
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
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
    refresh();
  });
};

const refreshTests = async (
  controller: vscode.TestController,
  workspaceFolder: vscode.WorkspaceFolder,
) => {
  console.log('Refreshing tests');
  const pattern = new vscode.RelativePattern(workspaceFolder, testGlobPattern);
  const matches = await vscode.workspace.findFiles(pattern);
  const filteredMatches = await asyncFilter(
    matches
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
      }),
    async ({ uri }) => {
      const data = (await vscode.workspace.fs.readFile(uri)).toString();
      const loaded = (await types).File(yaml.load(data));
      return !(loaded instanceof (await import('arktype')).type.errors);
    },
  );

  controller.items.forEach((item) => {
    controller.items.delete(item.id);
  });

  if (FLAT) {
    for (const { uri } of filteredMatches) {
      const testItem = await getTestsFromFile(controller, uri);
      controller.items.add(testItem);
    }
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
          const testItem = await getTestsFromFile(controller, uri);
          cursor.add(testItem);
        }

        cursor = cursor.get(id)!.children;
      }
    }
  }
};

const getTestsFromFile = async (
  controller: vscode.TestController,
  uri: vscode.Uri,
): Promise<vscode.TestItem> => {
  const mainTestItem = controller.createTestItem(
    uri.fsPath,
    unslugify(uri.toString()),
    uri,
  );

  const map = new SourceMap();
  const data = (await vscode.workspace.fs.readFile(uri)).toString();
  const loaded = (await types).File(
    yaml.load(data, {
      listener: map.listen(),
    }),
  );
  if (loaded instanceof (await import('arktype')).type.errors) {
    console.log('Skipping invalid testdriver yaml test file', uri.fsPath);
  } else {
    console.log('Getting tests from file', uri.fsPath);
    mainTestItem.range = getRange(map, ['steps']);
    for (const [i, step] of loaded.steps.entries()) {
      const test = await parseTests({
        controller,
        uri,
        map,
        item: step,
        path: ['steps', i],
      });
      mainTestItem.children.add(test);
    }
  }

  return mainTestItem;
};

const parseTests = async (options: {
  controller: vscode.TestController;
  uri: vscode.Uri;
  map: SourceMap;
  item:
    | Awaited<typeof types>['Step']['infer']
    | Awaited<typeof types>['Command']['infer'];
  path: Array<string | number>;
}): Promise<vscode.TestItem> => {
  const { controller, uri, map, item: item, path } = options;

  const mainTest = controller.createTestItem(
    `${uri.fsPath}:${path.join('.')}`,
    'commands' in item ? item.prompt : item.command,
    uri,
  );
  mainTest.range = getRange(map, path);

  if ('commands' in item) {
    for (const [i, command] of item.commands.entries()) {
      const nestedPath = [...path, 'commands', `${i}`];
      const test = await parseTests({
        controller,
        uri,
        map,
        item: command,
        path: nestedPath,
      });
      mainTest.children.add(test);
    }
  }
  //  else if (item.command === 'if') {
  //   for (const step of ['then', 'else'] as const) {
  //     if (step in item) {
  //       for (const [i, command] of item[step]!.entries() ?? []) {
  //         const nestedPath = [...path, step, i];
  //         const test = await parseTests({
  //           controller,
  //           uri,
  //           map,
  //           item: command,
  //           path: nestedPath,
  //         });
  //         mainTest.children.add(test);
  //       }
  //     }
  //   }
  // }

  return mainTest;
};

const getRange = (
  map: SourceMap,
  path: Array<string | number>,
): vscode.Range => {
  const pathPosition = map.lookup(path.map(String));
  if (!pathPosition) {
    throw new Error(`Could not find path "${path.join('.')}" in yaml file`);
  }
  const position = new vscode.Position(
    pathPosition.line - 1,
    pathPosition.column - 1,
  );
  return new vscode.Range(position, position);
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
      const test = queue.shift()!;

      if (test.children.size === 0) {
        run.started(test);
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        const instance = await getTestInstance();
        instance.on('output', (data) => {
          run.appendOutput(data.replace(/(?<!\r)\n/g, '\r\n'), undefined, test);
        });

        const file = (await vscode.workspace.fs.readFile(test.uri!)).toString();
        const loaded = (await types).File(yaml.load(file));
        if (loaded instanceof (await import('arktype')).type.errors) {
          continue;
        }

        const path =
          test.id
            .split(':')?.[1]
            ?.split('.')
            .map((part) => (isNaN(parseInt(part)) ? part : parseInt(part))) ??
          [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let cursor: any = loaded;
        for (const part of path) {
          cursor = cursor[part];
        }

        const block = yaml.dump(cursor);
        console.log({ loaded, path, cursor, block });

        await instance
          .run(`/yaml ${encodeURIComponent(block)}`, {
            signal: abortController.signal,
          })
          .then(() => run.passed(test))
          .catch((err) => run.failed(test, new vscode.TestMessage(err.message)))
          .finally(() => instance.destroy());

        console.log(`Test ${test.id} finished`);
      } else {
        test.children.forEach(addToQueue);
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
