import path from 'path';
import * as vscode from 'vscode';
import EventEmitter from 'node:events';
import { logger } from './utils/logger';

// Import the TestDriver agent directly from the package (npm link preferred for local dev)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestDriverAgent = require('testdriverai').Agent || require('testdriverai');
// Import events from the agent's events.js directly for reliability
let events;
try {
  events = require('testdriverai/agent/events.js').events;
} catch (e) {
  // fallback for npm link or direct dev usage
  events = require('../../testdriverai/agent/events.js').events;
}

interface EventsMap {
  vm_url: [string];
  exit: [number | null];
  output: [string];
  'log:log': [string];
  error: [string];
}

export class TDInstance extends EventEmitter<EventsMap> {
  public file?: string;
  public env: Record<string, string> = {};
  // No internal state management; rely on agent for state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public agent: any;
  private cleanup?: () => void;

  constructor(
    public cwd: string,
    {
      file,
      env,
      command = 'edit',
      flags = [],
      context,
    }: {
      file?: string;
      env?: Record<string, string>;
      focus?: boolean;
      command?: string;
      flags?: string[];
      context?: vscode.ExtensionContext;
    } = {},
  ) {
    super();
    if (file) {
      this.file = file;
    }
    if (env) {
      this.env = env;
    }

    // Initialize the agent
    this.initializeAgent(command, flags, context).catch((err) => {
      console.log('Failed to initialize agent:', err);
      logger.error('Failed to initialize agent:', {
        error: err,
        message: err?.message,
        stack: err?.stack,
      });
    });
  }

  private async initializeAgent(command: string, flags: string[], context?: vscode.ExtensionContext) {
    let apiKey: string | undefined;
    console.log('Initializing TestDriver agent with command/flags:', command, flags);

    if (context) {
      apiKey = await context.secrets.get('TD_API_KEY');
      console.log('Retrieved API key from secrets:', apiKey);
    } else {
      console.log('No context provided, API key will not be set');
    }
    this.agent = new TestDriverAgent();
    this.setupEventListeners();

    console.log('Setting up agent with command:', command, 'and flags:', flags);

    // Set up agent properties
    this.agent.cliArgs = {
      command: command || 'edit',
      args: [
        ...(this.file ? [path.join('testdriver', this.file)] : []),
      ],
      options: flags,
    };

    // Set working directory
    this.agent.workingDir = this.cwd;

    // Set the file path if provided
    if (this.file) {
      this.agent.thisFile = this.normalizeFilePath(this.file);
    }

    // Pass API key to agent and agent config if available
    if (apiKey) {
      this.agent.apiKey = apiKey;
      if (!this.agent.env) this.agent.env = {};
      console.log('Setting API key for agent:', apiKey);
      this.agent.env.TD_API_KEY = apiKey;
      // Also set on agent's config object so SDK picks it up
      try {
        // Try to require the config from the agent package
        const agentConfig = this.agent.config || require('testdriverai/agent/lib/config.js');
        agentConfig.TD_API_KEY = apiKey;
        this.agent.config = agentConfig;
      } catch (e) {
        console.warn('Could not set TD_API_KEY on agent config:', e);
      }
    }

    await this.agent.start();
  }

  private setupEventListeners() {
    this.agent.emitter.on('**', (data: any) => {
      console.log('event', this.agent.emitter.event, JSON.stringify(data ));
      this.emit(this.agent.emitter.event, data);
    });


    // Forward errors
    this.agent.emitter.on('error:*', (data: any) => {
      const event = this.agent.emitter.event;
      const errorMessage = `${event}: ${JSON.stringify(data)}`;

      if (errorMessage.includes('API KEY') || errorMessage.includes('API_KEY_MISSING_OR_INVALID')) {
        vscode.window.showErrorMessage(
          'TestDriver: API key missing or invalid. Please set your API key with the "TestDriver: Set API Key" command.',
          'Set API Key'
        ).then(selection => {
          if (selection === 'Set API Key') {
            vscode.commands.executeCommand('testdriver.setApiKey');
          }
        });
      }
    });
  }

  private normalizeFilePath(file: string): string {
    if (!file) {
      file = "testdriver/testdriver.yaml";
    }
    file = path.join(this.agent.workingDir, file);
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) {
      file += ".yaml";
    }
    return file;
  }

  async focus() {
    const uri = vscode.Uri.file(
      path.join(this.cwd, 'testdriver', this.file || 'testdriver.yaml'),
    );
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: true,
    });

    // Scroll to the end of the file
    if (editor) {
      const doc = editor.document;
      const lastLine = doc.lineCount - 1;
      const lastChar = doc.lineAt(lastLine).range.end;

      const position = new vscode.Position(lastLine, lastChar.character);
      editor.selection = new vscode.Selection(position, position);

      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport,
      );
    }
  }

  destroy() {
    this.cleanup?.();
    if (this.agent && this.agent.exit) {
      this.agent.exit(false);
    }
  }
}
