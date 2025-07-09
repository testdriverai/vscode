import { getActiveWorkspaceFolder } from './utils/helpers';
import { logger } from './utils/logger';

// Import the TestDriverAgent from the local testdriverai package
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TestDriverAgent } = require('testdriverai');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createCommandDefinitions } = require('testdriverai/agent/interface');

interface AgentCommand {
  description: string;
  args: Record<string, unknown>;
  flags: Record<string, unknown>;
  handler: (args: Record<string, unknown>, flags?: Record<string, unknown>) => Promise<void>;
}

type AgentCommands = Record<string, AgentCommand>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let globalAgent: any = null;
let globalCommands: AgentCommands = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAgent(): Promise<any> {
  if (!globalAgent) {
    const workspace = getActiveWorkspaceFolder();
    if (!workspace) {
      throw new Error('No workspace found');
    }

    // Create a new TestDriverAgent instance
    globalAgent = new TestDriverAgent();
    
    // Set the working directory
    globalAgent.workingDir = workspace.uri.fsPath;
    
    // Set up minimal CLI args for the agent
    globalAgent.cliArgs = {
      command: 'explore', // default command
      args: [],
      options: {}
    };
    
    // Set a default file if needed
    if (!globalAgent.thisFile) {
      globalAgent.thisFile = `${workspace.uri.fsPath}/testdriver/testdriver.yaml`;
    }
    
    // Note: We skip start() because it has CLI-specific initialization
    // that we don't need in the extension context
    
    // Create command definitions
    globalCommands = createCommandDefinitions(globalAgent);
    
    logger.info('TestDriverAgent initialized', { workingDir: globalAgent.workingDir });
  }
  
  return globalAgent;
}

export async function getCommands(): Promise<AgentCommands> {
  await getAgent(); // Ensure agent is initialized
  return globalCommands;
}

export async function executeCommand(
  commandName: string, 
  args: Record<string, unknown> = {}, 
  flags: Record<string, unknown> = {},
  callback?: (event: { type: string; data: unknown }) => void
): Promise<string> {
  const commands = await getCommands();
  const command = commands[commandName];
  
  if (!command) {
    throw new Error(`Command "${commandName}" not found`);
  }
  
  const agent = await getAgent();
  
  // Set up event listeners if callback is provided
  if (callback) {
    // Listen to various events that the agent might emit
    const eventTypes = [
      'log:markdown:static',
      'log:markdown:start', 
      'log:markdown:chunk',
      'log:markdown:end',
      'status',
      'terminal:stdout',
      'terminal:stderr'
    ];
    
    eventTypes.forEach(eventType => {
      agent.emitter.on(eventType, (data: unknown) => {
        callback({
          type: eventType,
          data: data
        });
      });
    });
  }
  
  try {
    // Execute the command
    await command.handler(args, flags);
    
    // Return some indication of success
    return 'Command executed successfully';
  } catch (error) {
    logger.error(`Error executing command "${commandName}"`, error);
    throw error;
  }
}

export function getAvailableCommands(): string[] {
  return Object.keys(globalCommands);
}

export function getCommandDescription(commandName: string): string | undefined {
  return globalCommands[commandName]?.description;
}

export async function cleanupAgent(): Promise<void> {
  if (globalAgent) {
    try {
      await globalAgent.exit(false);
    } catch (error) {
      logger.error('Error cleaning up agent', error);
    } finally {
      globalAgent = null;
      globalCommands = {};
    }
  }
}

export async function runYaml(
  yamlContent: string,
  callback?: (event: { type: string; data: unknown }) => void
): Promise<string> {
  const agent = await getAgent();
  
  // Set up event listeners if callback is provided
  if (callback) {
    const eventTypes = [
      'log:markdown:static',
      'log:markdown:start', 
      'log:markdown:chunk',
      'log:markdown:end',
      'status',
      'terminal:stdout',
      'terminal:stderr'
    ];
    
    eventTypes.forEach(eventType => {
      agent.emitter.on(eventType, (data: unknown) => {
        callback({
          type: eventType,
          data: data
        });
      });
    });
  }
  
  try {
    await agent.runRawYML(encodeURIComponent(yamlContent));
    return 'YAML executed successfully';
  } catch (error) {
    logger.error('Error executing YAML', error);
    throw error;
  }
}
