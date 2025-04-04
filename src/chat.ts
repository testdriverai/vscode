import * as vscode from 'vscode';
import { TDInstance } from './cli';
import { getActiveWorkspaceFolder } from './utils';
import spec from './spec';

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
  } else {

    stream.progress('Staring my engine...');

    console.log(_context.history)



    try {
        const messages = [
            vscode.LanguageModelChatMessage.User(spec),            ];

        // get all the previous participant messages
        const previousMessages = _context.history.filter(
          h => h instanceof vscode.ChatResponseTurn
        );

        // add the previous messages to the messages array
        previousMessages.forEach(m => {
          let fullMessage = '';
          m.response.forEach(r => {
            const mdPart = r as vscode.ChatResponseMarkdownPart;
            fullMessage += mdPart.value.value;
          });
          messages.push(vscode.LanguageModelChatMessage.Assistant(fullMessage));
        });

        // add in the user's message
        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

        // send the request
        const chatResponse = await request.model.sendRequest(messages, {}, token);

        for await (const fragment of chatResponse.text) {
            stream.markdown(fragment);
        }

    } catch (err) {
      console.log('err', err);
    }
  }
};
