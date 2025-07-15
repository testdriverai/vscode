import path from 'path';
import * as vscode from 'vscode';
import { getChatInstance } from './cli';
import { getActiveWorkspaceFolder } from './utils/helpers';
import spec from './spec';
import { track, logger } from './utils/logger';

export const PARTICIPANT_ID = 'testdriver.driver';

export function registerChatParticipant(context: vscode.ExtensionContext) {
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    handler,
  );
  participant.iconPath = vscode.Uri.file(
    path.join(context.extensionUri.fsPath, 'icon.png'),
  );

  participant.onDidReceiveFeedback((feedback) => {
    track({
      event: 'chat.feedback',
      properties: {
        kind:
          feedback.kind === vscode.ChatResultFeedbackKind.Helpful
            ? 'helpful'
            : 'unhelpful',
        result: feedback.result,
      },
    });
  });
}

const handler: vscode.ChatRequestHandler = async (
  request,
  context,
  stream,
  token,
) => {
  track({
    event: 'chat.request',
    properties: {
      prompt: request.prompt,
      command: request.command,
    },
  });
  if (request.command) {
    // Accept all agent commands, not just 'dry' and 'explore'
    if (typeof request.command === 'string' && request.command.length > 0) {
      const workspace = getActiveWorkspaceFolder();
      if (!workspace) {
        stream.progress('No workspace found');
        logger.warn('No workspace found for chat request');
        return {
          errorDetails: {
            message: 'No workspace found',
          },
        };
      }

      const abortController = new AbortController();
      token.onCancellationRequested(() => {
        track({
          event: 'chat.request.cancelled',
          properties: { prompt: request.prompt, command: request.command },
        });
        abortController.abort();
      });

      const instance = await getChatInstance();
      instance.focus();
      instance.on('status', (status: string) => {
        stream.progress(status);
      });
      try {
        const fullOutput = await instance.run(
          `/${request.command} ${request.prompt}`,
          { signal: abortController.signal },
        );
        // The agent should emit codeblock events directly; handle them in the event listeners if needed
        stream.markdown(fullOutput);
        return {
          metadata: {
            isCli: true,
            result: fullOutput,
            prompt: request.prompt,
            history: context.history,
            command: request.command,
          },
        };
      } catch (err: unknown) {
        logger.error(`Failed handling chat command "${request.command}"`, err);
        return {
          errorDetails: {
            message: `Failed handling chat command "${request.command}": ${(err as Error)?.message}`,
          },
          metadata: {
            isCli: true,
            prompt: request.prompt,
            command: request.command,
            history: context.history,
          },
        };
      }
    } else {
      stream.progress('Unsupported command: ' + request.command);
      return {
        errorDetails: {
          message: `Unsupported command`,
        },
        metadata: {
          isCli: true,
          prompt: request.prompt,
          command: request.command,
          history: context.history,
        },
      };
    }
  } else {
    stream.progress('thinking...');

    const messages = [vscode.LanguageModelChatMessage.User(spec)];

    try {
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
      const chatResponse = await request.model.sendRequest(messages, {}, token);

      let fullMessage = '';
      for await (const fragment of chatResponse.text) {
        fullMessage += fragment;
        stream.markdown(fragment);
      }
      return {
        metadata: {
          isCli: false,
          result: fullMessage,
          prompt: request.prompt,
          command: request.command,
          history: context.history,
        },
      };
    } catch (err) {
      logger.error('Failed handling chat request', err);
      return {
        errorDetails: {
          message: `Failed handling chat request: ${(err as Error)?.message}`,
        },
        metadata: {
          isCli: false,
          prompt: request.prompt,
          command: request.command,
          history: context.history,
        },
      };
    }
  }
};
