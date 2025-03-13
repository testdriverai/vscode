import { renderPrompt } from '@vscode/prompt-tsx';
import * as vscode from 'vscode';
import { homedir } from 'os';
import path from 'path';
const spawn = require('child_process').spawn;
const WebSocket = require('ws'); // Add WebSocket import

const PARTICIPANT_ID = 'testdriver.driver';

let tempFile = path.join(homedir(), `tmp/testdriver-${new Date().getTime()}.yml`);

// Connect to WebSocket server
const terminal = vscode.window.createTerminal("TestDriver");
terminal.show();
terminal.sendText(`/Users/ianjennings/Development/testdriverai/index.js ${tempFile}`);

interface WebSocketMessage {
  event: string;
  message?: string;
}

interface CallTDCLIResult {
  yml: string;
}

const callTDCLI = function (command: string, stream: vscode.ChatResponseStream): Promise<CallTDCLIResult> {

  const ws = new WebSocket('ws://localhost:8080');

  return new Promise((resolve, reject) => {

    ws.on('open', () => {
      console.log('WebSocket connection opened');
      ws.send(JSON.stringify({
        event: "input",
        data: command
      }));
    });

    ws.on('close', () => {
      console.log('WebSocket connection closed');
    });

    ws.on('error', (error: Error) => {
      console.error(`WebSocket error: ${error}`);
      console.log(error);
      reject(error);
    });

    let buff = '';
    let thisYML = '';
    let insideYML = false;
    let YMLever = false;
    let hasBlock = false;

    ws.on('message', (data: string) => {

      let parsedData: WebSocketMessage = JSON.parse(data);

      if (parsedData.event === 'output' && parsedData.message) {

        let nextmsg = parsedData.message;

        for (const char of parsedData.message) {

          buff += char;
          if (buff.slice(-3) === '```') {

            console.log('yml detected');

            insideYML = !insideYML;

            if (insideYML) {
              console.log('pushing');
              nextmsg = nextmsg + '';
              console.log(nextmsg);
              YMLever = true;
            }

          }

        }

        console.log(buff);
        console.log('--------');
        console.log(nextmsg);
        console.log('-------------------');
        stream.markdown(nextmsg);

        if (!insideYML && YMLever && !hasBlock) {

          // Render a button to trigger a VS Code command
          stream.button({
            command: 'testdriver.codeblock.run',
            title: vscode.l10n.t('Run Steps'),
            arguments: [] // Send the YML code as an argument
          });

          hasBlock = true;

        }

      }

      if (parsedData.event === 'done') {

        resolve({
          yml: thisYML,
	    });

      ws.on('close', () => {
        console.log('WebSocket connection closed');
        reject(new Error('WebSocket connection closed before receiving done event'));
      });
	}

    });

  });
}

vscode.commands.registerCommand('testdriver.codeblock.run', async () => {
  vscode.window.showInformationMessage(`Running YML steps:`);
  await callTDCLI(`/run ${tempFile}`, {} as vscode.ChatResponseStream);
});

interface ICatChatResult extends vscode.ChatResult {
    metadata: {
        command: string;
    }
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
	const handler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> => {

      // generate a temporary file

      if (request.command === 'dry') {

        stream.progress('Generating...');
        await callTDCLI('/dry ' + request.prompt, stream);
        await callTDCLI('/save ' + tempFile, stream);

      } else {

        stream.progress('Staring my engine...');

        try {
            const messages = [
                vscode.LanguageModelChatMessage.User('You are TestDriver.ai, the best quality assurance engineer in the world. Your job is help the user write tests. You have the special ability to understand whats on the users computer screen and help them write tests for it. All of your tests are in a special YML format. YML has commands and steps. Every new step that is copied from the chat should almost alwasys be appended to the end of the file.'),
                vscode.LanguageModelChatMessage.User(request.prompt)
            ];

            const chatResponse = await request.model.sendRequest(messages, {}, token);
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
    const cat = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    cat.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
    cat.followupProvider = {
        provideFollowups(_result: ICatChatResult, _context: vscode.ChatContext, _token: vscode.CancellationToken) {
            return [{
                prompt: 'let us play',
                label: vscode.l10n.t('Run this step'),
                command: 'play'
            } satisfies vscode.ChatFollowup];
        }
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
        }
    });

    context.subscriptions.push(cat.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
        // Log chat result feedback to be able to compute the success matric of the participant
        // unhelpful / totalRequests is a good success metric
        logger.logUsage('chatResultFeedback', {
            kind: feedback.kind
        });
    }));

}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleError(logger: vscode.TelemetryLogger, err: any, stream: vscode.ChatResponseStream): void {
    // making the chat request might fail because
    // - model does not exist
    // - user consent not given
    // - quote limits exceeded
    logger.logError(err);

    if (err instanceof vscode.LanguageModelError) {
        console.log(err.message, err.code, err.cause);
        if (err.cause instanceof Error && err.cause.message.includes('off_topic')) {
            stream.markdown(vscode.l10n.t('I\'m sorry, I can only explain computer science concepts.'));
        }
    } else {
        // re-throw other errors so they show up in the UI
        throw err;
    }
}
