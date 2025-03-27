import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import cli from './cli';
const PARTICIPANT_ID = 'testdriver.driver';
import spec from './spec';
import { getActiveWorkspaceFolder, run } from './utils';

vscode.commands.registerCommand('testdriver.codeblock.run', async (yaml) => {
  vscode.window.showInformationMessage(`Running YML steps:`);
  await cli.exec(`/yaml ${yaml}`);
});

vscode.commands.registerCommand('testdriver.init', async () => {
  let statusBar = vscode.window.setStatusBarMessage(
    'Initializing Testdriver...',
  );

  // Check workspace folder
  const workspaceFolder = getActiveWorkspaceFolder();
  statusBar.dispose();

  if (!workspaceFolder) {
    await vscode.window.showErrorMessage('No workspace folder found');
    return;
  }

  const folder = workspaceFolder.uri.fsPath;
  console.log('folder', folder);

  // Check if npm is installed
  statusBar = vscode.window.setStatusBarMessage('Checking npm...');
  const { error: npmError, stdout: npmVersion } = await run('npm -v', {
    cwd: folder,
  });
  statusBar.dispose();
  console.log('npmVersion', npmVersion);
  if (npmError) {
    await vscode.window.showErrorMessage('npm is not installed');
    return;
  }

  // Check if testdriverai is installed
  statusBar = vscode.window.setStatusBarMessage('Checking testdriverai...');
  const {
    error: tdError,
    stdout: tdStdout,
    stderr: tdStderr,
  } = await run('testdriverai --help', { cwd: folder });
  statusBar.dispose();

  console.log({ error: tdError, stdout: tdStdout, stderr: tdStderr });
  if (tdError) {
    statusBar = vscode.window.setStatusBarMessage('Installing testdriverai...');
    const { error: installError } = await run(
      'npm install -g testdriverai@beta',
      { cwd: folder },
    );
    statusBar.dispose();
    if (installError) {
      await vscode.window.showErrorMessage('Failed to install testdriverai');
      return;
    }
  }

  // Check if Testdriver is already initialized
  if (fs.existsSync(path.join(folder, 'testdriver'))) {
    await vscode.window.showInformationMessage(
      'Skipping, Testdriver is already initialized in this workspace',
    );
    return;
  }

  statusBar = vscode.window.setStatusBarMessage(
    'Initializing Testdriver project...',
  );
  const terminal = vscode.window.createTerminal('Testdriver');
  const promise = new Promise<void>((resolve) => {
    const disposable = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.terminal === terminal) {
        disposable.dispose();
        resolve();
      }
    });
  });
  terminal.sendText('testdriverai init');
  terminal.show();

  await promise.finally(() => {
    statusBar.dispose();
  });
});

interface ICatChatResult extends vscode.ChatResult {
  metadata: {
    command: string;
  };
}
// const ansiRegex = (({ onlyFirst = false } = {}) => {
//   const pattern = [
//     "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
//     "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
//   ].join("|");
//   return new RegExp(pattern, onlyFirst ? undefined : "g");
// })();

// function stripAnsi(string) {
//   if (typeof string !== "string") {
//     throw new TypeError(`Expected a \`string\`, got \`${typeof string}\``);
//   }

//   return string.replace(ansiRegex, "");
// }

export function registerSimpleParticipant(context: vscode.ExtensionContext) {
  // Define a Cat chat handler.
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    // generate a temporary file

    if (request.command === 'dry') {
      stream.progress('Looking at screen...');
      await cli.exec('/dry ' + request.prompt, stream);
    } else if (request.command === 'try') {
      stream.progress('Looking at screen...');
      await cli.exec(request.prompt, stream);
    } else {
      stream.progress('Staring my engine...');

      console.log(context.history);

      try {
        const messages = [vscode.LanguageModelChatMessage.User(spec)];

        // get all the previous participant messages
        const previousMessages = context.history.filter(
          (h) => h instanceof vscode.ChatResponseTurn,
        );

        // add the previous messages to the messages array
        previousMessages.forEach((m) => {
          let fullMessage = '';
          m.response.forEach((r) => {
            const mdPart = r as vscode.ChatResponseMarkdownPart;
            fullMessage += mdPart.value.value;
          });
          messages.push(vscode.LanguageModelChatMessage.Assistant(fullMessage));
        });

        // add in the user's message
        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

        // send the request
        const chatResponse = await request.model.sendRequest(
          messages,
          {},
          token,
        );

        for await (const fragment of chatResponse.text) {
          stream.markdown(fragment);
        }
      } catch (err) {
        console.log('err', err);
        handleError(logger, err, stream);
      }
    }
  };

  // Chat participants appear as top-level options in the chat input
  // when you type `@`, and can contribute sub-commands in the chat input
  // that appear when you type `/`.
  const td = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  td.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
  td.followupProvider = {
    provideFollowups(
      _result: ICatChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken,
    ) {
      return [
        {
          prompt: 'let us play',
          label: vscode.l10n.t('Run this step'),
          command: 'play',
        } satisfies vscode.ChatFollowup,
      ];
    },
  };

  const logger = vscode.env.createTelemetryLogger({
    sendEventData(eventName, data) {
      // Capture event telemetry
      console.log(`Event: ${eventName}`);
      console.log(`Data: ${JSON.stringify(data)}`);
    },
    sendErrorData(error, data) {
      // Capture error telemetry
      console.error(`Error: ${error}`);
      console.error(`Data: ${JSON.stringify(data)}`);
    },
  });

  context.subscriptions.push(
    td.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
      // Log chat result feedback to be able to compute the success matric of the participant
      // unhelpful / totalRequests is a good success metric
      logger.logUsage('chatResultFeedback', {
        kind: feedback.kind,
      });
    }),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleError(
  logger: vscode.TelemetryLogger,
  err: any,
  stream: vscode.ChatResponseStream,
): void {
  // making the chat request might fail because
  // - model does not exist
  // - user consent not given
  // - quote limits exceeded
  logger.logError(err);

  if (err instanceof vscode.LanguageModelError) {
    console.log(err.message, err.code, err.cause);
    if (err.cause instanceof Error && err.cause.message.includes('off_topic')) {
      stream.markdown(
        vscode.l10n.t(
          "I'm sorry, I can only explain computer science concepts.",
        ),
      );
    }
  } else {
    // re-throw other errors so they show up in the UI
    throw err;
  }
}
