import nodeIPC from 'node-ipc';
import * as vscode from 'vscode';
import EventEmitter from 'node:events';
import { ChildProcess, spawn } from 'node:child_process';
import { MarkdownStreamParser, MarkdownParserEvent } from './utils';

type InferType<T> = T extends new () => infer U ? U : undefined;
type IPCType = InferType<typeof nodeIPC.IPC>;
const { IPC } = nodeIPC;

interface EventsMap {
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
  state: 'pending' | 'idle' | 'busy' | 'exit';
  private client: IPCType;
  private process: ChildProcess;
  private serverId: string;
  private cleanup?: () => void;
  private isLocked = false;

  constructor(
    public workspace: vscode.WorkspaceFolder,
    public file?: string,
  ) {
    super();
    this.state = 'pending';

    this.client = new IPC();
    this.client.config.id = `testdriverai_${this.workspace.name}_${process.pid}`;
    this.client.config.retry = 50;
    this.client.config.maxRetries = MAX_RETRIES;
    this.client.config.silent = true;

    const args: string[] = [];
    if (file) {
      args.push(file);
    }
    this.process = spawn(`testdriverai`, args, {
      env: process.env,
      cwd: workspace.uri.fsPath,
      stdio: 'pipe',
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
      // .on('stdout', (data) => process.stdout.write(data))
      // .on('stderr', (data) => process.stderr.write(data))
      .on('output', (data) => process.stdout.write(data));
  }

  async run(
    command: string,
    options: {
      signal?: AbortSignal;
      callback?: (event: MarkdownParserEvent) => void;
    } = {},
  ) {
    if (this.isLocked) {
      throw new Error('A command is already running');
    }
    this.isLocked = true;
    const signal = options.signal ?? new AbortController().signal;

    await new Promise((resolve, reject) => {
      console.log('Waiting for cli to become available');
      this.once('idle', () => {
        console.log('cli is available');
        resolve(true);
      });
      this.once('exit', () => reject(new Error('Process exited')));
      signal.onabort = () => {
        reject(new Error('Command aborted'));
      };
    }).catch((err) => {
      this.isLocked = false;
      throw err;
    });

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
          code === 0 ? resolve(result) : reject(new Error('Process exited')),
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
