import * as crypto from 'crypto';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import WebSocket from 'ws';

import * as child_process from 'child_process';

// Store active debugger panels by session ID
const debuggerPanels: Map<string, vscode.WebviewPanel> = new Map();
const websocketConnections: Map<string, WebSocket> = new Map();
let processedSessions: Set<string> = new Set();

// File watchers for .testdriver/.previews/ in each workspace folder
const previewWatchers: Map<string, vscode.FileSystemWatcher> = new Map();

// Local HTTP server for receiving session notifications from SDK
let httpServer: http.Server | undefined;
let serverPort: number | undefined;
let registrationHeartbeat: ReturnType<typeof setInterval> | undefined;

// Path to the TestDriver directory (used for IPC between SDK and extension)
const SESSION_DIR = path.join(os.homedir(), '.testdriver');
const INSTANCES_DIR = path.join(SESSION_DIR, 'ide-instances');

// Generate a unique instance ID for this VS Code window
const instanceId = crypto.randomUUID();

interface SessionData {
  sessionId?: string;
  debuggerUrl: string;
  resolution: [number, number];
  testFile?: string;
  os?: string;
  timestamp: number;
}

interface InstanceRegistration {
  instanceId: string;
  port: number;
  workspacePaths: string[];
  pid: number;
  timestamp: number;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('TestDriver.ai extension is now active');

  // Ensure directories exist
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(SESSION_DIR));
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(INSTANCES_DIR));

  // Check MCP installed status on activation (sets walkthrough completion)
  await checkMcpInstalledStatus();

  // Register commands
  const openDebuggerCommand = vscode.commands.registerCommand(
    'testdriverai.openDebugger',
    () => openDebuggerPanel(context)
  );

  const closeDebuggerCommand = vscode.commands.registerCommand(
    'testdriverai.closeDebugger',
    () => closeAllDebuggerPanels()
  );

  const installMcpCommand = vscode.commands.registerCommand(
    'testdriverai.installMcp',
    () => installMcpServer()
  );

  const setApiKeyCommand = vscode.commands.registerCommand(
    'testdriverai.setApiKey',
    () => setApiKey(context)
  );

  const loginCommand = vscode.commands.registerCommand(
    'testdriverai.login',
    () => browserLogin(context)
  );

  const initProjectCommand = vscode.commands.registerCommand(
    'testdriverai.initProject',
    () => runInitProject(context)
  );

  const walkthroughCommand = vscode.commands.registerCommand(
    'testdriverai.walkthrough',
    () => {
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'testdriver.testdriver#gettingStarted',
        false
      );
    }
  );

  const chatWithAgentCommand = vscode.commands.registerCommand(
    'testdriverai.chatWithAgent',
    () => {
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: 'Go to http://testdriver-sandbox.vercel.app, login, and add an item to cart',
      });
    }
  );

  const makeRepeatableCommand = vscode.commands.registerCommand(
    'testdriverai.makeRepeatable',
    () => {
      // Send a follow-up message in the current chat session
      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: 'Turn this into a repeatable test with a github action',
      });
    }
  );

  context.subscriptions.push(
    openDebuggerCommand,
    closeDebuggerCommand,
    installMcpCommand,
    setApiKeyCommand,
    loginCommand,
    initProjectCommand,
    walkthroughCommand,
    chatWithAgentCommand,
    makeRepeatableCommand
  );

  // First-install walkthrough
  const isFirstInstall = context.globalState.get('testdriverai.firstInstall', true);
  if (isFirstInstall) {
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriver.testdriver#gettingStarted',
      false
    );
    context.globalState.update('testdriverai.firstInstall', false);
  }

  // Check if API key is already set
  context.secrets.get('TD_API_KEY').then(existingApiKey => {
    vscode.commands.executeCommand('setContext', 'testdriverai.hasApiKey', !!existingApiKey);
  });

  // Start local HTTP server for receiving session notifications
  startHttpServer(context);

  // Set up file watchers for .testdriver/.previews/ folders
  setupPreviewWatchers(context);

  // Listen for workspace folder changes to update watchers
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setupPreviewWatchers(context);
    })
  );

  // Auto-install MCP on first activation
  autoInstallMcp(context);

  // Periodically re-check MCP status so walkthrough step auto-completes
  // if user installs via the popup or manually
  const mcpCheckInterval = setInterval(() => checkMcpInstalledStatus(), 5000);
  context.subscriptions.push({ dispose: () => clearInterval(mcpCheckInterval) });
}

// ── API Key Management ──────────────────────────────────────────────────────

const API_BASE_URL = 'https://testdriver-api.onrender.com';

async function saveApiKey(context: vscode.ExtensionContext, apiKey: string): Promise<void> {
  await context.secrets.store('TD_API_KEY', apiKey);

  // Also write to workspace .env so MCP server and vitest can pick it up
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const envUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.env');
    let envContent = '';
    try {
      const raw = await vscode.workspace.fs.readFile(envUri);
      envContent = Buffer.from(raw).toString('utf-8');
      if (envContent.includes('TD_API_KEY=')) {
        envContent = envContent.replace(/^TD_API_KEY=.*$/m, '');
      }
    } catch {
      // .env doesn't exist yet
    }
    const newEnvContent = envContent.trim() + `\nTD_API_KEY=${apiKey}\n`;
    await vscode.workspace.fs.writeFile(envUri, Buffer.from(newEnvContent));
  }

  await vscode.commands.executeCommand('setContext', 'testdriverai.hasApiKey', true);
}

async function browserLogin(context: vscode.ExtensionContext): Promise<boolean> {
  // Step 1: Request a device code
  let deviceCode: string;
  let verificationUri: string;
  let expiresIn: number;
  let pollInterval: number;

  try {
    const res = await fetch(`${API_BASE_URL}/auth/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }

    const data = await res.json() as {
      device_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };
    deviceCode = data.device_code;
    verificationUri = data.verification_uri;
    expiresIn = data.expires_in || 900;
    pollInterval = (data.interval || 5) * 1000;
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to start login: ${err.message}`);
    return false;
  }

  // Step 2: Open browser
  await vscode.env.openExternal(vscode.Uri.parse(verificationUri));

  // Step 3: Poll for the token with a progress indicator
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Waiting for browser authorization…',
      cancellable: true,
    },
    async (_progress, cancellationToken) => {
      const timeout = expiresIn * 1000;
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        if (cancellationToken.isCancellationRequested) {
          return null;
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));

        try {
          const tokenRes = await fetch(`${API_BASE_URL}/auth/device/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceCode }),
          });

          const data = await tokenRes.json() as { apiKey?: string; error?: string };

          if (tokenRes.ok && data.apiKey) {
            return data.apiKey;
          }

          if (data.error === 'expired_token') {
            vscode.window.showErrorMessage('Authorization timed out. Please try again.');
            return null;
          }
          // authorization_pending — keep polling
        } catch {
          // Network hiccup — keep polling
        }
      }

      vscode.window.showErrorMessage('Authorization timed out. Please try again.');
      return null;
    }
  );

  if (result) {
    await saveApiKey(context, result);
    vscode.window.showInformationMessage('Signed in to TestDriver.ai! API key saved to .env.');
    return true;
  }

  return false;
}

async function setApiKey(context: vscode.ExtensionContext): Promise<boolean> {
  const existingKey = await context.secrets.get('TD_API_KEY');
  if (existingKey) {
    const overwrite = await vscode.window.showQuickPick(
      ['Yes, replace it', 'No, keep existing'],
      { placeHolder: 'API key is already set. Do you want to replace it?' }
    );
    if (overwrite !== 'Yes, replace it') {
      return true;
    }
  }

  const method = await vscode.window.showQuickPick(
    [
      { label: '$(globe) Sign in with browser', description: 'Recommended', value: 'browser' },
      { label: '$(key) Enter API key manually', description: '', value: 'manual' },
    ],
    { placeHolder: 'How would you like to authenticate?' }
  );

  if (!method) {
    return false;
  }

  if (method.value === 'browser') {
    return browserLogin(context);
  }

  // Manual entry fallback
  const apiKey = await vscode.window.showInputBox({
    prompt: 'Enter your TestDriver API key (from console.testdriver.ai/team)',
    ignoreFocusOut: true,
    password: true
  });

  if (apiKey && apiKey.trim()) {
    await saveApiKey(context, apiKey.trim());
    vscode.window.showInformationMessage('TestDriver API key saved to .env.');
    return true;
  } else {
    vscode.window.showWarningMessage('No API key entered.');
    return false;
  }
}

// ── Project Initialization ──────────────────────────────────────────────────

async function runInitProject(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('Open a workspace folder first to initialize a TestDriver project.');
    return;
  }

  const targetDir = workspaceFolders[0].uri.fsPath;
  const apiKey = await context.secrets.get('TD_API_KEY');

  // Read .env to check if API key is already there
  let envHasKey = false;
  if (apiKey) {
    const envUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.env');
    try {
      const raw = await vscode.workspace.fs.readFile(envUri);
      const content = Buffer.from(raw).toString('utf-8');
      envHasKey = /^TD_API_KEY=.+$/m.test(content);
    } catch {
      // .env doesn't exist yet — we'll write the key before running init
    }

    // Ensure .env has the API key so init picks it up and skips the auth prompt
    if (!envHasKey) {
      await saveApiKey(context, apiKey);
    }
  }

  const outputChannel = vscode.window.createOutputChannel('TestDriver Init');
  outputChannel.show();
  outputChannel.appendLine('Initializing TestDriver project...\n');

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Initializing TestDriver project…',
      cancellable: false,
    },
    async (progress) => {
      return new Promise<void>((resolve) => {
        // Run npx testdriverai init in the workspace folder
        // The init command will detect TD_API_KEY in .env and skip the auth prompt
        const env = { ...process.env, TD_API_KEY: apiKey || '', NO_COLOR: '1', FORCE_COLOR: '0' };

        const proc = child_process.spawn('npx', ['testdriverai', 'init'], {
          cwd: targetDir,
          env,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Since TD_API_KEY is in .env, init will skip the prompt entirely
        proc.stdin?.end();

        let lastMessage = '';

        const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

        proc.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          for (const line of text.split('\n')) {
            const clean = stripAnsi(line).trim();
            if (clean) {
              outputChannel.appendLine(clean);
              const label = clean.replace(/^[\s✓⊘⚠ℹ📦🚀❌✅]+/, '').trim();
              if (label && label !== lastMessage) {
                lastMessage = label;
                progress.report({ message: label });
              }
            }
          }
        });

        proc.stderr?.on('data', (data: Buffer) => {
          const text = stripAnsi(data.toString()).trim();
          if (text) {
            outputChannel.appendLine(text);
          }
        });

        proc.on('close', (code) => {
          if (code === 0) {
            outputChannel.appendLine('\n✅ Project initialized successfully!');
            vscode.window.showInformationMessage('TestDriver project initialized!');
            vscode.commands.executeCommand('setContext', 'testdriverai.projectInitialized', true);
            // Re-check MCP status — init may have created .vscode/mcp.json
            checkMcpInstalledStatus();
          } else {
            outputChannel.appendLine(`\n❌ Init exited with code ${code}`);
            vscode.window.showWarningMessage('TestDriver init completed with errors. See Output panel for details.');
          }
          resolve();
        });

        proc.on('error', (err) => {
          outputChannel.appendLine(`\n❌ Error: ${err.message}`);
          vscode.window.showErrorMessage(`TestDriver init failed: ${err.message}`);
          resolve();
        });
      });
    }
  );
}

// ── HTTP Server for SDK → Extension IPC ─────────────────────────────────────

function startHttpServer(context: vscode.ExtensionContext) {
  httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/session') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const sessionData: SessionData = JSON.parse(body);
          handleSessionNotification(context, sessionData);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          console.error('Error parsing session data:', error);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', instanceId }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(0, '127.0.0.1', () => {
    const address = httpServer!.address();
    if (address && typeof address === 'object') {
      serverPort = address.port;
      console.log(`TestDriver extension server listening on port ${serverPort}`);
      registerInstance();
      // Refresh the registration timestamp every 30 seconds so the SDK
      // never considers this instance stale (SDK threshold is 60 seconds).
      registrationHeartbeat = setInterval(registerInstance, 30000);
    }
  });

  httpServer.on('error', (error) => {
    console.error('HTTP server error:', error);
  });
}

async function registerInstance() {
  if (!serverPort) { return; }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspacePaths = workspaceFolders
    ? workspaceFolders.map(f => f.uri.fsPath)
    : [];

  const registration: InstanceRegistration = {
    instanceId,
    port: serverPort,
    workspacePaths,
    pid: process.pid,
    timestamp: Date.now()
  };

  const registrationFile = path.join(INSTANCES_DIR, `${instanceId}.json`);
  try {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(registrationFile),
      Buffer.from(JSON.stringify(registration, null, 2))
    );
    console.log(`Registered VS Code instance: ${registrationFile}`);
  } catch (error) {
    console.error('Failed to register instance:', error);
  }
}

async function unregisterInstance() {
  const registrationFile = path.join(INSTANCES_DIR, `${instanceId}.json`);
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(registrationFile));
  } catch {
    // Ignore cleanup errors
  }
}

function handleSessionNotification(context: vscode.ExtensionContext, sessionData: SessionData) {
  if (!sessionData.sessionId) {
    sessionData.sessionId = `session-${Date.now()}`;
  }

  const config = vscode.workspace.getConfiguration('testdriverai');
  const autoOpen = config.get<boolean>('autoOpenPreview', true);

  if (autoOpen && !processedSessions.has(sessionData.sessionId)) {
    processedSessions.add(sessionData.sessionId);
    openDebuggerPanel(context, sessionData);
  }
}

// ── Preview File Watchers ───────────────────────────────────────────────────

async function setupPreviewWatchers(context: vscode.ExtensionContext) {
  for (const [, watcher] of previewWatchers) {
    watcher.dispose();
  }
  previewWatchers.clear();

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) { return; }

  for (const folder of workspaceFolders) {
    const previewsDirUri = vscode.Uri.joinPath(folder.uri, '.testdriver', '.previews');

    try {
      await vscode.workspace.fs.createDirectory(previewsDirUri);
    } catch (error) {
      console.error(`Failed to create previews directory: ${error}`);
    }

    // Use ** so the watcher finds .testdriver folders nested at any depth
    // (e.g. testdriver/.testdriver/.previews/ as well as .testdriver/.previews/)
    const pattern = new vscode.RelativePattern(folder, '**/.testdriver/.previews/*.json');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate((uri) => handlePreviewFile(context, uri));
    watcher.onDidChange((uri) => handlePreviewFile(context, uri));

    previewWatchers.set(folder.uri.fsPath, watcher);
    context.subscriptions.push(watcher);

    processOrCleanupPreviewFiles(context, folder);
  }
}

// Process recent preview files (written within the last 30 seconds) and delete stale ones.
// This handles the race condition where a file is written before the watcher is fully active.
// Scans all .testdriver/.previews directories found anywhere under the workspace folder.
async function processOrCleanupPreviewFiles(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder) {
  const RECENT_THRESHOLD_MS = 30000;
  try {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/.testdriver/.previews/*.json')
    );
    for (const fileUri of files) {
      try {
        const stat = await vscode.workspace.fs.stat(fileUri);
        if (Date.now() - stat.mtime < RECENT_THRESHOLD_MS) {
          await handlePreviewFile(context, fileUri);
        } else {
          await vscode.workspace.fs.delete(fileUri);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function handlePreviewFile(context: vscode.ExtensionContext, uri: vscode.Uri) {
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(data).toString('utf-8');
    if (!content.trim()) { return; }

    const sessionData: SessionData = JSON.parse(content);
    if (!sessionData.sessionId) {
      sessionData.sessionId = path.basename(uri.fsPath, '.json');
    }

    if (processedSessions.has(sessionData.sessionId)) { return; }

    handleSessionNotification(context, sessionData);

    try { await vscode.workspace.fs.delete(uri); } catch { /* ignore */ }
  } catch (error) {
    console.error(`Error processing preview file ${uri.fsPath}:`, error);
  }
}

// ── Live Preview Panel ──────────────────────────────────────────────────────

function getTestFileName(testFile?: string): string {
  if (!testFile) { return 'TestDriver'; }
  return testFile.split('/').pop()?.split('\\').pop() || 'TestDriver';
}

function formatPanelTitle(status: string, testFile?: string): string {
  return `[${status}] ${getTestFileName(testFile)}`;
}

function openDebuggerPanel(context: vscode.ExtensionContext, sessionData?: SessionData) {
  const sessionId = sessionData?.sessionId || `manual-${Date.now()}`;

  const existingPanel = debuggerPanels.get(sessionId);
  if (existingPanel) {
    existingPanel.reveal(vscode.ViewColumn.Active);
    if (sessionData) {
      updateDebuggerContent(existingPanel, sessionData, context, sessionId);
    }
    return;
  }

  const initialTitle = sessionData
    ? formatPanelTitle('Loading', sessionData.testFile)
    : 'TestDriver Live Preview';

  const panel = vscode.window.createWebviewPanel(
    'testdriverDebugger',
    initialTitle,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'media'))
      ]
    }
  );

  debuggerPanels.set(sessionId, panel);

  panel.iconPath = {
    light: vscode.Uri.file(path.join(context.extensionPath, 'media', 'icon.png')),
    dark: vscode.Uri.file(path.join(context.extensionPath, 'media', 'icon.png'))
  };

  panel.onDidDispose(() => {
    debuggerPanels.delete(sessionId);
    disconnectWebSocket(sessionId);
    processedSessions.delete(sessionId);
  }, null, context.subscriptions);

  if (sessionData) {
    updateDebuggerContent(panel, sessionData, context, sessionId);
  } else {
    panel.webview.html = getWaitingHtml();
  }
}

function updateDebuggerContent(panel: vscode.WebviewPanel, sessionData: SessionData, context: vscode.ExtensionContext, sessionId: string) {
  connectToWebSocket(sessionData.debuggerUrl, panel, sessionId, sessionData.testFile);

  const data = {
    resolution: sessionData.resolution,
    url: extractVncUrl(sessionData.debuggerUrl),
    token: 'V3b8wG9',
    testFile: sessionData.testFile || null,
    os: sessionData.os || 'linux'
  };

  const encodedData = Buffer.from(JSON.stringify(data)).toString('base64');
  panel.title = formatPanelTitle('Running', sessionData.testFile);
  panel.webview.html = getDebuggerHtml(sessionData.debuggerUrl, encodedData);
}

function extractVncUrl(debuggerUrl: string): string {
  try {
    const url = new URL(debuggerUrl);
    const dataParam = url.searchParams.get('data');
    if (dataParam) {
      const data = JSON.parse(Buffer.from(dataParam, 'base64').toString());
      return data.url || '';
    }
  } catch (error) {
    console.error('Error extracting VNC URL:', error);
  }
  return '';
}

// ── WebSocket Connection ────────────────────────────────────────────────────

function connectToWebSocket(debuggerUrl: string, panel: vscode.WebviewPanel, sessionId: string, testFile?: string) {
  disconnectWebSocket(sessionId);

  try {
    const url = new URL(debuggerUrl);
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${url.host}`;
    const ws = new WebSocket(wsUrl);
    websocketConnections.set(sessionId, ws);

    ws.on('open', () => {
      console.log(`Connected to TestDriver debugger WebSocket for session: ${sessionId}`);
    });

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        panel.webview.postMessage(message);

        if (message.event) {
          switch (message.event) {
            case 'test:start':
              panel.title = formatPanelTitle('Running', testFile);
              break;
            case 'test:stop':
              panel.title = formatPanelTitle('Stopped', testFile);
              break;
            case 'test:success':
              panel.title = formatPanelTitle('Passed', testFile);
              break;
            case 'test:error':
              panel.title = formatPanelTitle('Failed', testFile);
              break;
            case 'error:fatal':
            case 'error:sdk':
              panel.title = formatPanelTitle('Error', testFile);
              break;
          }
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    });

    ws.on('close', () => {
      panel.title = formatPanelTitle('Done', testFile);
    });

    ws.on('error', (error: Error) => {
      console.error(`WebSocket error for session ${sessionId}:`, error);
    });
  } catch (error) {
    console.error('Error connecting to WebSocket:', error);
  }
}

function disconnectWebSocket(sessionId: string) {
  const ws = websocketConnections.get(sessionId);
  if (ws) {
    ws.close();
    websocketConnections.delete(sessionId);
  }
}

function closeAllDebuggerPanels() {
  for (const [sessionId, panel] of debuggerPanels) {
    panel.dispose();
    disconnectWebSocket(sessionId);
  }
  debuggerPanels.clear();
  processedSessions.clear();
}

// ── MCP Server Installation ────────────────────────────────────────────────

async function checkMcpInstalledStatus(): Promise<boolean> {
  const mcpConfigPaths = [
    path.join(os.homedir(), '.vscode', 'mcp.json'),
    path.join(os.homedir(), '.cursor', 'mcp.json')
  ];

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    mcpConfigPaths.unshift(
      path.join(workspaceFolders[0].uri.fsPath, '.vscode', 'mcp.json'),
      path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'mcp.json')
    );
  }

  for (const configPath of mcpConfigPaths) {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(configPath));
      const cfg = JSON.parse(Buffer.from(raw).toString('utf-8'));
      // Check both 'servers' (standard VS Code format) and 'mcpServers' (legacy)
      if (cfg.servers?.['testdriver'] || cfg.mcpServers?.['testdriver']) {
        await vscode.commands.executeCommand('setContext', 'testdriverai.mcpInstalled', true);
        return true;
      }
    } catch { /* file does not exist or is unreadable, continue */ }
  }

  await vscode.commands.executeCommand('setContext', 'testdriverai.mcpInstalled', false);
  return false;
}

async function installMcpServer() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('Please open a folder before installing TestDriver MCP.');
    return;
  }

  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  const mcpConfigPaths = [
    path.join(workspaceRoot, '.vscode', 'mcp.json'),
    path.join(workspaceRoot, '.cursor', 'mcp.json'),
    path.join(os.homedir(), '.vscode', 'mcp.json'),
    path.join(os.homedir(), '.cursor', 'mcp.json')
  ];

  let configPath: string | undefined;
  for (const p of mcpConfigPaths) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(p));
      configPath = p;
      break;
    } catch { /* file does not exist, continue */ }
  }

  if (!configPath) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Workspace (.vscode/mcp.json)', value: mcpConfigPaths[0] },
        { label: 'Workspace (.cursor/mcp.json)', value: mcpConfigPaths[1] },
        { label: 'Global (~/.vscode/mcp.json)', value: mcpConfigPaths[2] },
        { label: 'Global (~/.cursor/mcp.json)', value: mcpConfigPaths[3] }
      ],
      { placeHolder: 'Where would you like to install the TestDriver MCP server?' }
    );
    if (!choice) { return; }
    configPath = choice.value;
  }

  const configDirUri = vscode.Uri.file(path.dirname(configPath));
  await vscode.workspace.fs.createDirectory(configDirUri);

  let config: { servers?: Record<string, unknown>; mcpServers?: Record<string, unknown> } = {};
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(configPath));
    try {
      config = JSON.parse(Buffer.from(raw).toString('utf-8'));
    } catch (parseError) {
      vscode.window.showErrorMessage(`Error reading MCP config: ${parseError}`);
      return;
    }
  } catch {
    // File doesn't exist yet — start with an empty config
  }

  if (!config.servers) {
    config.servers = {};
  }

  // Check both 'servers' (standard) and 'mcpServers' (legacy) for existing config
  if (config.servers['testdriver'] || config.mcpServers?.['testdriver']) {
    const overwrite = await vscode.window.showWarningMessage(
      'TestDriver MCP is already configured. Overwrite?',
      'Yes',
      'No'
    );
    if (overwrite !== 'Yes') { return; }
  }

  config.servers['testdriver'] = {
    command: 'npx',
    args: ['-p', 'testdriverai', 'testdriverai-mcp'],
    env: {
      TD_PREVIEW: 'ide'
    }
  };

  try {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(configPath),
      Buffer.from(JSON.stringify(config, null, 2))
    );
    vscode.window.showInformationMessage(
      `TestDriver MCP installed successfully at ${configPath}. The MCP server reads TD_API_KEY from your workspace .env file.`
    );
    // Update context so walkthrough step auto-completes
    await checkMcpInstalledStatus();
  } catch (error) {
    vscode.window.showErrorMessage(`Error writing MCP config: ${error}`);
  }
}

async function autoInstallMcp(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('testdriverai');
  if (config.get<boolean>('mcpPromptDismissed', false)) { return; }

  const mcpConfigPaths = [
    path.join(os.homedir(), '.vscode', 'mcp.json'),
    path.join(os.homedir(), '.cursor', 'mcp.json')
  ];

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    mcpConfigPaths.unshift(
      path.join(workspaceFolders[0].uri.fsPath, '.vscode', 'mcp.json'),
      path.join(workspaceFolders[0].uri.fsPath, '.cursor', 'mcp.json')
    );
  }

  for (const configPath of mcpConfigPaths) {
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(configPath));
      const cfg = JSON.parse(Buffer.from(raw).toString('utf-8'));
      // Check both 'servers' (standard VS Code format) and 'mcpServers' (legacy)
      if (cfg.servers?.['testdriver'] || cfg.mcpServers?.['testdriver']) { return; }
    } catch { /* file does not exist or is unreadable, continue */ }
  }

  const install = await vscode.window.showInformationMessage(
    'Would you like to install the TestDriver MCP server for AI-assisted test creation?',
    'Install',
    'Not Now',
    'Never'
  );

  if (install === 'Install') {
    await installMcpServer();
  } else if (install === 'Not Now') {
    // Don't dismiss permanently — remind them via the walkthrough
    vscode.window.showInformationMessage(
      'You can install the MCP server later from the Getting Started walkthrough.',
      'Open Walkthrough'
    ).then(choice => {
      if (choice === 'Open Walkthrough') {
        vscode.commands.executeCommand(
          'workbench.action.openWalkthrough',
          'testdriver.testdriver#gettingStarted',
          false
        );
      }
    });
  } else if (install === 'Never') {
    await config.update('mcpPromptDismissed', true, vscode.ConfigurationTarget.Global);
  }
}

// ── Webview HTML ────────────────────────────────────────────────────────────

function getWaitingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TestDriver Live Preview</title>
  <style>
    body {
      background-color: #1e1e1e;
      color: #cccccc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
    }
    h1 { font-size: 24px; font-weight: 500; margin-bottom: 16px; }
    p { font-size: 14px; color: #888; max-width: 400px; line-height: 1.6; }
    code { background: #2d2d2d; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    .spinner {
      width: 40px; height: 40px;
      border: 3px solid #333; border-top-color: #b0cf34;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 24px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <h1>Waiting for TestDriver...</h1>
  <p>Run a test with <code>preview: "ide"</code> to see the live execution here.</p>
  <p style="margin-top: 16px;"><code>const testdriver = TestDriver(context, { preview: "ide" });</code></p>
</body>
</html>`;
}

function getDebuggerHtml(debuggerUrl: string, encodedData: string): string {
  const url = new URL(debuggerUrl);
  url.searchParams.set('data', encodedData);
  const fullUrl = url.toString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://localhost:* https://localhost:*; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>TestDriver Live Preview</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background-color: #1e1e1e; }
    iframe { width: 100%; height: 100%; border: none; }
    .error { display: none; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #cccccc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 20px; }
    .error.visible { display: flex; }
    .error h2 { color: #f44336; margin-bottom: 16px; }
    .error p { color: #888; max-width: 400px; line-height: 1.6; }
  </style>
</head>
<body>
  <iframe id="debugger-frame" src="${fullUrl}" sandbox="allow-scripts allow-same-origin"></iframe>
  <div class="error" id="error-message">
    <h2>Connection Lost</h2>
    <p>The TestDriver debugger server is no longer running. Start a new test to reconnect.</p>
  </div>
  <script>
    const iframe = document.getElementById('debugger-frame');
    const errorDiv = document.getElementById('error-message');
    iframe.onerror = function() {
      iframe.style.display = 'none';
      errorDiv.classList.add('visible');
    };
    window.addEventListener('message', event => {
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage(event.data, '*');
      }
    });
  </script>
</body>
</html>`;
}

// ── Deactivation ────────────────────────────────────────────────────────────

export function deactivate() {
  closeAllDebuggerPanels();

  if (registrationHeartbeat) {
    clearInterval(registrationHeartbeat);
    registrationHeartbeat = undefined;
  }

  if (httpServer) {
    httpServer.close();
    httpServer = undefined;
  }

  for (const [, watcher] of previewWatchers) {
    watcher.dispose();
  }
  previewWatchers.clear();

  unregisterInstance();
}
