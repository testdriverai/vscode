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
  codeBlockLang = '';
  codeBlockContent = '';
  markdownContent = '';
  backtickCount = 0;
  potentialCodeBlockStart = false;
  potentialCodeBlockEnd = false;
  languageCapture = false;

  // Buffer for recent characters
  recentChars: string[] = [];
  MAX_RECENT_CHARS = 10;
  constructor() {
    super();
  }

  // Process a single character
  processChar(char: string) {
    // Add to recent characters buffer for lookahead/lookbehind
    this.recentChars.push(char);
    if (this.recentChars.length > this.MAX_RECENT_CHARS) {
      this.recentChars.shift();
    }

    // Handle backticks for code block detection
    if (char === '`') {
      this.backtickCount++;

      // If we get 3 backticks, we're either entering or exiting a code block
      if (this.backtickCount === 3) {
        if (this.inCodeBlock) {
          // When we detect closing backticks, immediately remove backticks that might have been added to content
          // For example if we have "content```" in the buffer, we need to trim the backticks
          if (this.codeBlockContent.endsWith('``')) {
            this.codeBlockContent = this.codeBlockContent.slice(0, -2);
          } else if (this.codeBlockContent.endsWith('`')) {
            this.codeBlockContent = this.codeBlockContent.slice(0, -1);
          }
          this.potentialCodeBlockEnd = true;
        } else {
          this.potentialCodeBlockStart = true;
          this.languageCapture = true; // Start capturing language after ```
        }
      }
    } else {
      // Reset backtick counter if we see a non-backtick
      if (this.backtickCount > 0 && this.backtickCount < 3) {
        // If we saw some backticks but not 3, add them to the content
        if (this.inCodeBlock) {
          this.codeBlockContent += '`'.repeat(this.backtickCount);
        } else {
          this.markdownContent += '`'.repeat(this.backtickCount);
        }
      }
      this.backtickCount = 0;

      // Handle potential code block starts
      if (this.potentialCodeBlockStart) {
        if (this.languageCapture) {
          // If we're capturing a language and see whitespace, end language capture
          if (/\s/.test(char)) {
            this.languageCapture = false;
          } else {
            // Otherwise add to language string
            this.codeBlockLang += char;
            return; // Skip adding to content
          }
        }

        // If we see a newline, confirm code block start
        if (char === '\n') {
          // Emit markdown content collected so far
          if (this.markdownContent.trim()) {
            this.emit('markdown', this.markdownContent);
          }

          this.markdownContent = '';
          this.inCodeBlock = true;
          this.potentialCodeBlockStart = false;
          return; // Skip adding this newline to content
        }
      }

      // Handle potential code block ends
      if (this.potentialCodeBlockEnd) {
        // If we see a newline or carriage return, confirm code block end
        if (char === '\n' || char === '\r') {
          // Emit the code block WITHOUT the closing backticks
          const codeBlockObj = this.codeBlockLang
            ? { type: this.codeBlockLang, content: this.codeBlockContent }
            : { content: this.codeBlockContent };

          this.emit('codeblock', codeBlockObj);

          this.codeBlockContent = '';
          this.codeBlockLang = '';
          this.inCodeBlock = false;
          this.potentialCodeBlockEnd = false;

          // Add this newline to the markdown content
          this.markdownContent = '\n';
          return;
        } else {
          // If we see something other than a newline after ```,
          // it wasn't a code block end
          this.potentialCodeBlockEnd = false;
          this.codeBlockContent += '```' + char;
          return;
        }
      }

      // Add character to the appropriate buffer
      if (this.inCodeBlock) {
        this.codeBlockContent += char;
      } else {
        this.markdownContent += char;
      }
    }
  }

  // Call this when the stream ends to emit any remaining content
  end() {
    // First check if we're in a potential code block end state
    // This happens when the input ends with ```
    if (this.potentialCodeBlockEnd && this.inCodeBlock) {
      // Emit the code block WITHOUT including the closing backticks
      const codeBlockObj = this.codeBlockLang
        ? { type: this.codeBlockLang, content: this.codeBlockContent }
        : { content: this.codeBlockContent };

      this.emit('codeblock', codeBlockObj);

      // Reset state
      this.inCodeBlock = false;
      this.codeBlockLang = '';
      this.codeBlockContent = '';
      this.markdownContent = '';
      this.backtickCount = 0;
      this.potentialCodeBlockEnd = false;
      return;
    }

    // Handle any other remaining backticks
    if (this.backtickCount > 0) {
      if (this.inCodeBlock) {
        this.codeBlockContent += '`'.repeat(this.backtickCount);
      } else {
        this.markdownContent += '`'.repeat(this.backtickCount);
      }
    }

    // Emit any remaining content
    if (this.inCodeBlock) {
      const codeBlockObj = this.codeBlockLang
        ? { type: this.codeBlockLang, content: this.codeBlockContent }
        : { content: this.codeBlockContent };

      this.emit('codeblock', codeBlockObj);
    } else if (this.markdownContent.trim()) {
      this.emit('markdown', this.markdownContent);
    }

    // Reset state
    this.inCodeBlock = false;
    this.codeBlockLang = '';
    this.codeBlockContent = '';
    this.markdownContent = '';
    this.backtickCount = 0;
    this.potentialCodeBlockEnd = false;
  }
}
