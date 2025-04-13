import path from 'node:path';
import * as vscode from 'vscode';
import { exec } from 'node:child_process';
import { EventEmitter } from 'node:events';

export function run(command: string, { cwd }: { cwd?: string } = {}) {
  return new Promise<{ stdout: string; stderr: string; error: Error | null }>(
    (resolve) => {
      exec(command, { cwd, encoding: 'utf-8' }, (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          error,
        });
      });
    },
  );
}

export function exists(uri: vscode.Uri) {
  return vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );
}

export function getUri(
  relativePath: string,
  workspaceFolder: vscode.WorkspaceFolder,
) {
  return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, relativePath));
}

export async function isFileType(
  type: vscode.FileType,
  file: vscode.Uri,
): Promise<boolean | null> {
  return vscode.workspace.fs.stat(file).then(
    (stat) => stat.type === type,
    () => null,
  );
}

export function beautifyFilename(name: string) {
  return name
    .split('/')
    .pop()!
    .replace(/\.[a-zA-Z0-9]$/, '')
    .replace(/[_-]/g, ' ');
}

export const getActiveWorkspaceFolder = () => {
  const workspaces = vscode.workspace.workspaceFolders;
  if (!workspaces || workspaces.length === 0) {
    return null;
  }

  const activeEditorPath = vscode.window.activeTextEditor?.document.uri.path;

  if (!activeEditorPath) {
    return workspaces[0];
  }

  const matchingWorkspace = workspaces.find((wsFolder) => {
    const relative = path.relative(wsFolder.uri.fsPath, activeEditorPath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });

  return matchingWorkspace ?? workspaces[0];
};

type Markdown = string;
interface MultilineCodeblock {
  type?: string;
  content: string;
}

export type MarkdownParserEvent = Markdown | MultilineCodeblock;
export class MarkdownStreamParser extends EventEmitter<{
  markdown: [Markdown];
  codeblock: [MultilineCodeblock];
}> {
  inCodeBlock = false;
  codeBlockContent = '';
  codeBlockLang = '';
  // Buffer for recent characters
  recentChars: string[] = [];
  MAX_RECENT_CHARS = 10;
  constructor() {
    super();
  }

  // Process a single character
  processChar(char: string) {

    this.emit('markdown', char);

    // Add the character to the recent characters buffer
    this.recentChars.push(char);
    if (this.recentChars.length > this.MAX_RECENT_CHARS) {
      this.recentChars.shift(); // Remove the oldest character
    }

    // check if the last 3 characters were ```
    if (this.recentChars.slice(-3).join('') === '```') {

      this.recentChars = []; // Clear the buffer

      this.inCodeBlock = !this.inCodeBlock;

      if (!this.inCodeBlock && this.codeBlockContent) {

        const lines = this.codeBlockContent.split('\n');

        this.codeBlockLang = lines[0].replaceAll('`', '').trim();
        const strippedContent = lines.slice(1, -1).join('\n');

        const codeBlockObj = this.codeBlockLang
        ? { type: this.codeBlockLang, content: strippedContent }
        : { content: strippedContent };

        this.emit('codeblock', codeBlockObj);
        this.codeBlockContent = '';
        this.codeBlockLang = '';
      }

    }

    if (this.inCodeBlock) {
      this.codeBlockContent += char;
      this.codeBlockLang = '';
    }

  }

  // Call this when the stream ends to emit any remaining content
  end() {

    // Reset state
    this.inCodeBlock = false;
    this.codeBlockContent = '';
  }
}
