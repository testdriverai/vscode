import * as vscode from 'vscode';
import { PARTICIPANT_ID } from '../chat';

const getUserPrompt = async () => {
  let userInput: string | undefined;
  while (!userInput?.trim().length) {
    userInput = await vscode.window.showInputBox({
      value: '',
      prompt: 'What should TestDriver do?',
      placeHolder: 'log in',
      validateInput: (text) => {
        if (!text?.trim().length) {
          return 'Prompt cannot be empty';
        }
      },
    });
  }
  return userInput.trim();
};

export const handleTDCommandInChat = async (
  testdriverCommand: 'dry' | 'explore',
  testdriverPrompt?: string,
) => {
  const options = {
    query: `@testdriver /${testdriverCommand} ${testdriverPrompt}`,
    participant: PARTICIPANT_ID,
  };

  const chatVisible = vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.label.includes('Chat')),
  );

  const command = chatVisible
    ? 'workbench.action.chat.new'
    : 'workbench.action.chat.open';

  await vscode.commands.executeCommand(`${command}`, options);
};

export const testdriverCommand = (command: 'dry' | 'explore') => async () => {
  const prompt = await getUserPrompt();
  await handleTDCommandInChat(command, prompt);
};
