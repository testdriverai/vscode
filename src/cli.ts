import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import nodeIPC from 'node-ipc';
import * as vscode from 'vscode';
import EventEmitter from 'node:events';
import { ChildProcess, spawn } from 'node:child_process';
import {
  MarkdownParserEvent,
  MarkdownStreamParser,
  getActiveWorkspaceFolder,
} from './utils';

type InferType<T> = T extends new () => infer U ? U : undefined;
type IPCType = InferType<typeof nodeIPC.IPC>;
const { IPC } = nodeIPC;

interface EventsMap {
  vm_url: [string];
  status: [string];
  stdout: [string];
  stderr: [string];
  exit: [number | null];
  output: [string];
  pending: [];
  idle: [];
  busy: [];
}

const MAX_RETRIES = 10;
export class TDInstance extends EventEmitter<EventsMap> {
  id: string;
  public file?: string;
  public env: Record<string, string> = {};
  state: 'pending' | 'idle' | 'busy' | 'exit';
  private client: IPCType;
  private process: ChildProcess;
  private serverId: string;
  private overlayId?: string;
  private cleanup?: () => void;
  private isLocked = false;

  constructor(
    public cwd: string,
    {
      file,
      env,
    }: {
      file?: string;
      env?: Record<string, string>;
    } = {},
  ) {
    super();
    if (file) {
      this.file = file;
    }
    if (env) {
      this.env = env;
    }
    this.id = `testdriverai_vscode_${process.pid}`;
    this.state = 'pending';

    this.overlayId = crypto.randomUUID();
    this.client = new IPC();
    this.client.config.id = this.id;
    this.client.config.retry = 50;
    this.client.config.maxRetries = MAX_RETRIES;
    this.client.config.silent = true;

    const terminal = vscode.window.createTerminal({
      name: `TestDriver AI - vscode extension`,
      cwd: this.cwd,
      env: {
        ...this.env,
      },
    });
    terminal.sendText(
      `testdriverai --renderer ${this.overlayId} && exit`,
      true,
    );

    const args: string[] = [];
    if (this.file) {
      args.push(this.file);
    }
    this.process = spawn(`testdriverai`, args, {
      stdio: 'pipe',
      cwd: this.cwd,
      env: {
      ...process.env,
      ...this.env,
      TD_OVERLAY_ID: this.overlayId,
      FORCE_COLOR: 'true', // Enable color rendering
      },
    });

    this.serverId = `testdriverai_${this.process.pid}`;

    this.on('pending', () => (this.state = 'pending'))
      .on('idle', () => (this.state = 'idle'))
      .on('busy', () => (this.state = 'busy'))
      .on('exit', () => {
        this.state = 'exit';
        this.destroy();
      });

    this.process.stdout!.on('data', (data) =>
      this.emit('stdout', data.toString()),
    );
    this.process.stderr!.on('data', (data) =>
      this.emit('stderr', data.toString()),
    );

    this.process.once('error', () => {
      this.emit('exit', 1);
    });

    this.process.once('exit', (code) => {
      this.emit('exit', code);
    });

    this.process.once('spawn', () => {
      let retryCount = 0;
      this.client.connectTo(this.serverId);

      const onConnect = () => {
        retryCount = 0;
        this.emit('pending');
      };
      const onError = () => {
        retryCount++;
        if (this.state === 'pending' && retryCount <= MAX_RETRIES) {
          return;
        }
        this.emit('exit', 1);
      };

      const onDisconnect = () => {
        if (this.state !== 'pending') {
          this.emit('exit', null);
        }
      };

      const handleMessage = (message: { event: string; data: unknown }) => {
        const { event, data } = message;
        switch (event) {
          case 'interactive':
            this.emit((data as boolean) ? 'idle' : 'busy');
            break;
          case 'output':
            this.emit('output', data as string);
            break;
          case 'status':
            this.emit('status', data as string);
            break;
          case 'show:vm':
            this.emit('vm_url', data as string);
            break;
        }
      };

      this.client.of[this.serverId]
        .on('connect', onConnect)
        .on('error', onError)
        .on('disconnect', onDisconnect)
        .on('message', handleMessage);

      this.cleanup = () => {
        this.client.of[this.serverId]
          ?.off('connect', onConnect)
          ?.off('error', onError)
          ?.off('disconnect', onDisconnect)
          ?.off('message', handleMessage);
      };
    });

    // Debug
    this.on('pending', () => console.log('[debug:pending]'))
      .on('idle', () => console.log('[debug:idle]'))
      .on('busy', () => console.log('[debug:busy]'))
      .on('exit', (code) => console.log('[debug:exit]', code))
      .on('stdout', (data) => process.stdout.write(data))
      .on('stderr', (data) => process.stderr.write(data))
      // .on('output', (data) => process.stdout.write(data));
  }

  async run(
    command: string,
    options: {
      signal?: AbortSignal;
      callback?: (event: MarkdownParserEvent) => void;
    } = {},
  ) {
    const signal = options.signal ?? new AbortController().signal;
    do {
      await new Promise((resolve, reject) => {
        this.once('idle', () => {
          console.log('cli is available');
          resolve(true);
        });
        this.once('exit', () => reject(new Error('Process exited')));
        signal.onabort = () => {
          reject(new Error('Command aborted'));
        };
        switch (this.state) {
          case 'idle':
            return resolve(true);
          case 'exit':
            return reject(new Error('Process exited'));
        }
        console.log('Waiting for cli to become available');
      }).catch((err) => {
        throw err;
      });
    } while (this.isLocked);

    this.isLocked = true;
    return new Promise<{ fullOutput: string; events: MarkdownParserEvent[] }>(
      (resolve, reject) => {
        signal.onabort = () => {
          reject(new Error('Command aborted'));
        };
        const result: { fullOutput: string; events: MarkdownParserEvent[] } = {
          fullOutput: '',
          events: [],
        };

        this.once('exit', (code) =>
          code ? reject(new Error('Process exited')) : resolve(result),
        );
        const parser = new MarkdownStreamParser();

        const handleOutput = (message: string) => {
          result.fullOutput += message;
          for (const char of message) {
            parser.processChar(char);
          }
        };

        parser.on('markdown', (event) => {
          result.events.push(event);
          options.callback?.(event);
        });

        parser.on('codeblock', (event) => {
          result.events.push(event);
          options.callback?.(event);
        });

        this.once('busy', () => {
          this.on('output', handleOutput);
          this.once('idle', () => {
            this.off('output', handleOutput);
            parser.end();
            resolve(result);
          });
        });

        this.client.of[this.serverId].emit('message', {
          event: 'input',
          data: command,
        });
      },
    )
      .then((result) => {
        this.isLocked = false;
        return result;
      })
      .catch((err) => {
        this.isLocked = false;
        this.emit('exit', 1);
        throw err;
      });
  }

  destroy() {
    this.process.stdout?.removeAllListeners();
    this.process.stderr?.removeAllListeners();
    this.cleanup?.();
    this.client.disconnect(this.serverId);
    this.process.kill(9);
    this.state = 'exit';
  }
}

let chatInstance: TDInstance | null = null;
export const getChatInstance = async () => {
  console.log('getChatInstance', chatInstance);

  if (!chatInstance || chatInstance.state === 'exit') {
    console.log('Creating new chat instance');
    const workingDir = getActiveWorkspaceFolder()?.uri.fsPath;
    let env: Record<string, string> = {};
    if (workingDir) {
      const envPath = path.join(workingDir, '.env');
      if (fs.existsSync(envPath)) {
        const file = await vscode.workspace.fs.readFile(
          vscode.Uri.file(envPath),
        );
        env = dotenv.parse(file.toString());
        console.log('env', env);
      }
    }
    chatInstance = new TDInstance(os.tmpdir(), { env });
  }
  return chatInstance;
};

let testInstance: TDInstance | null = null;
export const getTestInstance = async () => {
  console.log('getTestInstance', testInstance);

  if (!testInstance || testInstance.state === 'exit') {
    console.log('Creating new test instance');
    const workingDir = getActiveWorkspaceFolder()?.uri.fsPath;
    let env: Record<string, string> = {};
    if (workingDir) {
      const envPath = path.join(workingDir, '.env');
      if (fs.existsSync(envPath)) {
        const file = await vscode.workspace.fs.readFile(
          vscode.Uri.file(envPath),
        );
        env = dotenv.parse(file.toString());
        console.log('env', env);
      }
    }
    testInstance = new TDInstance(workingDir ?? os.tmpdir(), { env });
  }
  return testInstance;
};
