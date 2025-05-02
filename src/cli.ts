import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import * as vscode from 'vscode';
import EventEmitter from 'node:events';
import { ChildProcess, fork } from 'node:child_process';
import {
  MarkdownParserEvent,
  MarkdownStreamParser,
  getActiveWorkspaceFolder,
} from './utils/helpers';
import {
  getJSPath,
  compareVersions,
  getExecutablePath,
  getPackageJsonVersion,
} from './utils/npm';
import { logger } from './utils/logger';

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
  private process: ChildProcess;
  private overlayId?: string;
  private cleanup?: () => void;
  private isLocked = false;

  constructor(
    public cwd: string,
    {
      file,
      env,
      focus = false,
    }: {
      file?: string;
      env?: Record<string, string>;
      focus?: boolean;
    } = {},
  ) {
    super();
    if (file) {
      this.file = file;
    }
    if (env) {
      this.env = env;
    }

    const requiredVersion = '5.3.14';

    this.id = `testdriverai_vscode_${process.pid}`;
    this.state = 'pending';

    this.overlayId = crypto.randomUUID();

    const terminal = vscode.window.createTerminal({
      iconPath: 'media/icon.png',
      name: `TestDriver`,
      cwd: this.cwd,
      env: {
        FORCE_COLOR: 'true',
        ...this.env,
      },
    });

    let testdriverPath;
    try {
      testdriverPath = getExecutablePath();
    } catch {
      // display error to user
      vscode.window.showErrorMessage(
        '`testdriverai` executable not found in PATH. Install `testdriverai` globally using `npm install -g testdriverai@beta`',
      );
      throw new Error(
        '`testdriverai` not found in PATH. Install `testdriverai` globally using `npm install -g testdriverai@beta`',
      );
    }

    const testdriverVersion = getPackageJsonVersion();

    if (compareVersions(testdriverVersion, requiredVersion) <= 0) {
      const message = `testdriverai version must be greater than ${requiredVersion}. Current version: ${testdriverVersion}`;
      logger.error(
        'Error: testdriverai version is too old. Please update to the latest version.',
      );
      vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    if (testdriverVersion) {
      logger.info(`Using testdriverai version: ${testdriverVersion}`);
    }

    const isWin = process.platform === 'win32';
    const rendererId = this.overlayId;
    const quotedPath = `"${testdriverPath}"`;

    const command = isWin
      ? `powershell -NoProfile -Command "& node ${quotedPath} --renderer ${rendererId}"`
      : `node ${quotedPath} --renderer ${rendererId}`;

    logger.info('Starting testdriverai with command:', command);
    terminal.sendText(command, true);

    const args: string[] = [];
    if (this.file) {
      args.push(path.join('testdriver', this.file));
    }

    const jsPath = getJSPath();

    this.process = fork(jsPath, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ...this.env,
        TD_OVERLAY_ID: this.overlayId,
        FORCE_COLOR: 'true', // Enable color rendering
      },
    });

    // log all the output to a new vscode output channel called testdriver.ai and remove ansi codes
    const outputChannel = vscode.window.createOutputChannel(
      'TestDriver',
      'markdown',
    );

    if (focus) {
      outputChannel.show();
    }

    this.process.once('error', (e) => {
      logger.error('Error starting process', e);
      this.state = 'exit';
      this.emit('exit', 1);
    });

    this.process.once('exit', (code) => {
      this.state = 'exit';
      this.emit('exit', code);
    });

    this.process.once('spawn', async () => {
      let retryCount = 0;

      const stripAnsi = await import('strip-ansi');
      this.process.stdout?.on('data', (data) => {
        this.emit('stdout', data.toString());
        const strippedData = stripAnsi.default(data.toString());
        outputChannel.append(strippedData);
      });

      this.process.stderr?.on('data', (data) => {
        this.emit('stderr', data.toString());
        const strippedData = stripAnsi.default(data.toString());
        outputChannel.append(strippedData);
      });

      const onConnect = () => {
        retryCount = 0;
        this.state = 'pending';
        this.emit('pending');
      };
      const onError = () => {
        retryCount++;
        if (this.state === 'pending' && retryCount <= MAX_RETRIES) {
          return;
        }
        this.state = 'exit';
        this.emit('exit', 1);
      };

      const onDisconnect = () => {
        if (this.state !== 'pending') {
          this.state = 'exit';
          this.emit('exit', null);
        }
      };

      const handleMessage = (message: { event: string; data: unknown }) => {
        let d;
        try {
          d = message;
        } catch (e) {
          logger.error('Error parsing message', e);
          return;
        }

        switch (d.event) {
          case 'interactive':
            this.state = (d.data as boolean) ? 'idle' : 'busy';
            this.emit(this.state);
            break;
          case 'output':
            this.emit('output', d.data as string);
            break;
          case 'status':
            this.emit('status', d.data as string);
            break;
          case 'show:vm':
            this.emit('vm_url', d.data as string);
            break;
          case 'pending':
            this.state = 'pending';
            this.emit('pending');
            break;
          case 'idle':
            this.state = 'idle';
            this.emit('idle');
            break;
          case 'busy':
            this.state = 'busy';
            this.emit('busy');
            break;
          case 'exit':
            this.state = 'exit';
            this.emit('exit', d.data as number);
            this.destroy();
            break;
        }
      };

      this.process
        .on('connect', onConnect)
        .on('error', onError)
        .on('disconnect', onDisconnect)
        .on('message', handleMessage);

      this.cleanup = () => {
        this.process
          ?.off('connect', onConnect)
          ?.off('error', onError)
          ?.off('disconnect', onDisconnect)
          ?.off('message', handleMessage);
      };
    });

    // Debug
    this.on('pending', () => logger.debug('[pending]'))
      .on('idle', () => logger.debug('[idle]'))
      .on('busy', () => logger.debug('[busy]'))
      .on('exit', (code) => logger.debug('[exit]', code))
      .on('stdout', (data) => process.stdout.write(data))
      .on('stderr', (data) => process.stderr.write(data))
      .on('output', (data) => logger.debug('[output]', data));
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
          resolve(true);
        });
        this.once('exit', () => reject(new Error('Process exited')));
        signal.onabort = () => {
          logger.info('Aborting command');
          this.destroy();
          reject(new Error('Command aborted'));
        };
        switch (this.state) {
          case 'idle':
            return resolve(true);
          case 'exit':
            return reject(new Error('Process exited'));
        }
        logger.info('Waiting for cli to become available');
      }).catch((err) => {
        throw err;
      });
    } while (this.isLocked);

    this.isLocked = true;
    return new Promise<{ fullOutput: string; events: MarkdownParserEvent[] }>(
      (resolve, reject) => {
        signal.onabort = () => {
          logger.info('Aborting command');
          this.destroy();
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

        this.process.send(
          JSON.stringify({
            event: 'input',
            data: command,
          }),
        );
      },
    )
      .then((result) => {
        this.isLocked = false;
        return result;
      })
      .catch((err) => {
        this.isLocked = false;
        this.state = 'exit';
        this.emit('exit', 1);
        throw err;
      });
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
    this.process.stdout?.removeAllListeners();
    this.process.stderr?.removeAllListeners();
    this.cleanup?.();
    this.process.kill(9);
    this.state = 'exit';
  }
}

let chatInstance: TDInstance | null = null;

export const getChatInstance = async () => {
  if (!chatInstance || chatInstance.state === 'exit') {
    const workingDir = getActiveWorkspaceFolder()?.uri.fsPath;

    let env: Record<string, string> = {};
    if (workingDir) {
      const envPath = path.join(workingDir, '.env');
      if (fs.existsSync(envPath)) {
        const file = await vscode.workspace.fs.readFile(
          vscode.Uri.file(envPath),
        );
        env = dotenv.parse(file.toString());
      }
    }
    const dir = path.join(workingDir ?? '', 'testdriver');

    // make a testdriver folder inside
    // the workspace directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // make a testdriver.yaml file inside
    // the testdriver folder
    const now = new Date();
    const formattedDate = now.toISOString().replace(/[:.]/g, '-');
    const file = `testdriver_${formattedDate}.yaml`;
    const testdriverYaml = path.join(dir, file);
    fs.writeFileSync(testdriverYaml, '', { flag: 'w' });

    chatInstance = new TDInstance(workingDir ?? '', {
      env,
      file,
      focus: true,
    });
  }
  return chatInstance;
};
