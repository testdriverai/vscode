import { track, logger, init as loggerInit } from './utils/logger';
import { getEnv } from './utils/env';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { init } from './utils/init';
import { setupTests } from './tests';

import { registerCommands, registerTestdriverRunTest } from './commands';

// We'll get the testdriverai version at runtime to avoid bundling issues

export function deactivate() {}

export async function activate(context: vscode.ExtensionContext) {
  // Register chat participant using VS Code API
  try {
    console.log('Chat participant registered successfully');
  } catch (e) {
    // Ignore if chat API is not available
    console.warn('Chat participant registration failed:', e);
  }
  init(context);

  const isFirstInstall = context.globalState.get(
    'testdriver.firstInstall',
    true,
  );

  // Get testdriverai version at runtime to avoid bundling issues
  let testdriverVersion = 'unknown';
  try {
    const testdriverPackageJson = require('testdriverai/package.json');
    testdriverVersion = testdriverPackageJson.version;
  } catch (e) {
    console.warn('Could not get testdriverai version:', e);
  }

  logger.info('TestDriverAI extension activated', {
    isFirstInstall,
    testdriverVersion,
  });

  if (isFirstInstall) {
    track({ event: 'extension.installed' });
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriver.testdriver#gettingStarted',
      false,
    );
    // Prompt user to install MCP server for 'testdriver' key
    vscode.window.showInformationMessage(
      'Would you like to install an MCP server for your TestDriver project? This will connect your documentation to AI applications.',
      'Install MCP Server'
    ).then(selection => {
      if (selection === 'Install MCP Server') {
        vscode.commands.executeCommand('testdriver.addMcpServer');
      }
    });
    context.globalState.update('testdriver.firstInstall', false);
  }

  track({ event: 'extension.activated' });
  registerCommands();
  registerTestdriverRunTest(context);
  // Only call setupTests(context) once to initialize the shared controller
  const controller = setupTests(context);
  context.subscriptions.push(controller);

  vscode.workspace.onDidOpenTextDocument((doc) => {
    const isYaml = doc.languageId === 'yaml' || doc.fileName.endsWith('.yaml');
    const isTestDriverYaml = doc.uri.fsPath.includes(path.join('testdriver', ''));

    if (isYaml && isTestDriverYaml) {
      const yamlExt = vscode.extensions.getExtension('redhat.vscode-yaml');

      if (!yamlExt) {
        vscode.window.showInformationMessage(
          'TestDriver: Install "YAML by Red Hat" for schema validation and better editing in TestDriver YAML files.',
          'Install'
        ).then(selection => {
          if (selection === 'Install') {
            vscode.commands.executeCommand(
              'workbench.extensions.installExtension',
              'redhat.vscode-yaml'
            );
          }
        });
      }
    }
  });

  const consent = context.globalState.get<string>('testdriver.analyticsConsent');

  if (consent === undefined) {
    const result = await vscode.window.showInformationMessage(
      'Help us improve TestDriver by sending anonymous usage data.',
      'Yes, allow',
      'No, thanks'
    );

    if (result === 'Yes, allow') {
      await context.globalState.update('testdriver.analyticsConsent', 'granted');
      vscode.window.showInformationMessage('Thank you! Analytics enabled.');
    } else if (result === 'No, thanks') {
      await context.globalState.update('testdriver.analyticsConsent', 'denied');
    }
  }

  const disposable = vscode.commands.registerCommand('testdriver.toggleAnalytics', async () => {
    const current = context.globalState.get<string>('testdriver.analyticsConsent') || 'denied';
    const next = current === 'granted' ? 'denied' : 'granted';

    await context.globalState.update('testdriver.analyticsConsent', next);
    vscode.window.showInformationMessage(
      `Analytics ${next === 'granted' ? 'enabled' : 'disabled'}.`
    );
    const env = getEnv();
    loggerInit(context, env);
  });

  context.subscriptions.push(disposable);

  const apiKeyDisposable = vscode.commands.registerCommand('testdriver.setApiKey', async () => {
    const apiKey = await vscode.window.showInputBox({
      prompt: 'Enter your TestDriver API key (from app.testdriver.ai/team)',
      ignoreFocusOut: true,
      password: true
    });
    if (apiKey) {
      await context.secrets.store('TD_API_KEY', apiKey);
      vscode.window.showInformationMessage('TestDriver API key saved securely.');
    } else {
      vscode.window.showWarningMessage('No API key entered.');
    }
  });
  context.subscriptions.push(apiKeyDisposable);

  const addMcpServerDisposable = vscode.commands.registerCommand('testdriver.addMcpServer', async () => {
    const terminal = vscode.window.createTerminal({ name: 'MCP Server Install' });
    terminal.show();
    terminal.sendText('npx mint-mcp add testdriver', true);
    vscode.window.showInformationMessage('Installing MCP server for: testdriver');
  });
  context.subscriptions.push(addMcpServerDisposable);

  const cloneExampleDisposable = vscode.commands.registerCommand('testdriver.cloneExample', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showWarningMessage('Please open a workspace folder first to clone the example.');
      return;
    }

    // Create a truly temp dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testdriverai-'));
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const terminal = vscode.window.createTerminal({
      name: 'TestDriver Example',
      cwd: workspacePath
    });
    terminal.show();
    terminal.sendText(`git clone https://github.com/testdriverai/cli "${tmpDir}"`, true);
    terminal.sendText(`mv "${tmpDir}/testdriver" ./`, true);
    terminal.sendText(`rm -rf "${tmpDir}"`, true);
    vscode.window.showInformationMessage('Cloned TestDriver example project to workspace/testdriver');
  });
  context.subscriptions.push(cloneExampleDisposable);
}
