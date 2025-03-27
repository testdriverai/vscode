import { homedir } from 'os';
import path from 'path';
import WebSocket from 'ws'; // Add WebSocket import
import * as vscode from 'vscode';

interface CallTDCLIResult {
  yml: string;
}

const tempFile = `testdriver/testdriver-${new Date().getTime()}.yaml`;

interface WebSocketMessage {
  event: string;
  message?: string;
}

// Connect to WebSocket server
const terminal = vscode.window.createTerminal('TestDriver');
terminal.show();
terminal.sendText(
  `/Users/ianjennings/Development/testdriverai/index.js ${tempFile}`,
);

const callTDCLI = function (
  command: string,
  stream: vscode.ChatResponseStream,
): Promise<CallTDCLIResult> {
  const ws = new WebSocket('ws://localhost:8080');

  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('WebSocket connection opened');
      ws.send(
        JSON.stringify({
          event: 'input',
          data: command,
        }),
      );
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

        if (!insideYML && YMLever) {
          // Render a button to trigger a VS Code command
          stream.button({
            command: 'testdriver.codeblock.run',
            title: vscode.l10n.t('Run Steps'),
            arguments: [tempFile], // Send the YML code as an argument
          });

          YMLever = false; // Reset YMLever to handle multiple code blocks
        }
      }

      if (parsedData.event === 'done') {
        resolve({
          yml: null,
        });
      }

      ws.on('close', () => {
        console.log('WebSocket connection closed');
        reject(
          new Error('WebSocket connection closed before receiving done event'),
        );
      });
    });
  });
};

export default {
  exec: callTDCLI,
};
