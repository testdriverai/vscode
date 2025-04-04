import * as vscode from 'vscode';
import { PARTICIPANT_ID } from '../chat';

const getUserPrompt = async () => {
  const userInput = await vscode.window.showInputBox({
    value: '',
    prompt: 'Prompt for TestDriver',
    placeHolder: 'Your prompt ...',
    validateInput: (text) => {
      return text.trim().length > 0 ? null : 'Prompt cannot be empty';
    },
  });
  return userInput?.trim();
};

export const handleTDCommandInChat = async (
  testdriverCommand: 'dry' | 'try',
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

  await vscode.commands.executeCommand(`/${command}`, options);
};

export const testdriverCommand = (command: 'dry' | 'try') => async () => {
  const prompt = await getUserPrompt();
  await handleTDCommandInChat(command, prompt);
};
