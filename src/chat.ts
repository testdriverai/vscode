import * as vscode from 'vscode';
import { TDInstance } from './cli';
import { getActiveWorkspaceFolder } from './utils';

export const PARTICIPANT_ID = 'testdriver.driver';

export function registerChatParticipant(_context: vscode.ExtensionContext) {
  vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
}

const handler: vscode.ChatRequestHandler = async (
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> => {
  if (request.command) {
    const commands = ['dry', 'try'];
    if (commands.includes(request.command)) {
      const workspace = getActiveWorkspaceFolder();
      if (!workspace) {
        stream.progress('No workspace found');
        return;
      }
      stream.progress('Looking at screen...');

      const abortController = new AbortController();
      token.onCancellationRequested(() => abortController.abort());

      const file = `testdriver/testdriver_${Date.now()}.yaml`;
      const instance = new TDInstance(workspace, file);

      await instance.run(`/${request.command} ${request.prompt}`, {
        signal: abortController.signal,
        callback: (event) => {
          if (typeof event === 'string') {
            stream.markdown(event);
          } else {
            stream.markdown(
              `\n\n\`\`\`${event.type ?? ''}\n${event.content}\n\`\`\`\n\n`,
            );
            if (['yaml', 'yml'].includes(event.type?.toLowerCase() ?? '')) {
              stream.button({
                command: 'testdriver.codeblock.run',
                title: vscode.l10n.t('Run Steps'),
                arguments: [file, workspace], // Send the YML code as an argument
              });
            }
          }
        },
      });
      instance.destroy();
    } else {
      stream.progress('Unsupported command: ' + request.command);
    }
    return;
  }
};
