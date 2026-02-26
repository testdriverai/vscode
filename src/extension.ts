import * as crypto from 'crypto';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import WebSocket from 'ws';

// Single grid panel that shows all active sessions
let gridPanel: vscode.WebviewPanel | undefined;
let gridPanelReady = false;
const gridPendingMessages: object[] = [];

// Active sessions shown in the grid, keyed by session ID
const activeSessions: Map<string, SessionData> = new Map();

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

  const walkthroughCommand = vscode.commands.registerCommand(
    'testdriverai.walkthrough',
    () => {
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'testdriverai.testdriverai#gettingStarted',
        false
      );
    }
  );

  context.subscriptions.push(
    openDebuggerCommand,
    closeDebuggerCommand,
    installMcpCommand,
    setApiKeyCommand,
    walkthroughCommand
  );

  // First-install walkthrough
  const isFirstInstall = context.globalState.get('testdriverai.firstInstall', true);
  if (isFirstInstall) {
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'testdriverai.testdriverai#gettingStarted',
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
}

// ── API Key Management ──────────────────────────────────────────────────────

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

  const apiKey = await vscode.window.showInputBox({
    prompt: 'Enter your TestDriver API key (from app.testdriver.ai/team)',
    ignoreFocusOut: true,
    password: true
  });

  if (apiKey && apiKey.trim()) {
    await context.secrets.store('TD_API_KEY', apiKey.trim());
    vscode.window.showInformationMessage('TestDriver API key saved securely.');
    await vscode.commands.executeCommand('setContext', 'testdriverai.hasApiKey', true);
    return true;
  } else {
    vscode.window.showWarningMessage('No API key entered.');
    return false;
  }
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

function sendToGrid(message: object) {
  if (gridPanel && gridPanelReady) {
    gridPanel.webview.postMessage(message);
  } else {
    gridPendingMessages.push(message);
  }
}

function updateGridPanelTitle() {
  if (!gridPanel) { return; }
  const count = activeSessions.size;
  gridPanel.title = count > 1
    ? `TestDriver: Live Preview (${count} tests)`
    : 'TestDriver: Live Preview';
}

function openDebuggerPanel(context: vscode.ExtensionContext, sessionData?: SessionData) {
  const sessionId = sessionData?.sessionId || `manual-${Date.now()}`;

  if (!gridPanel) {
    gridPanelReady = false;
    gridPendingMessages.length = 0;

    const panel = vscode.window.createWebviewPanel(
      'testdriverDebugger',
      'TestDriver: Live Preview',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'media'))
        ]
      }
    );

    gridPanel = panel;

    panel.iconPath = {
      light: vscode.Uri.file(path.join(context.extensionPath, 'media', 'icon.png')),
      dark: vscode.Uri.file(path.join(context.extensionPath, 'media', 'icon.png'))
    };

    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.type === 'ready') {
          gridPanelReady = true;
          for (const pending of gridPendingMessages) {
            panel.webview.postMessage(pending);
          }
          gridPendingMessages.length = 0;
        }
      },
      null,
      context.subscriptions
    );

    panel.onDidDispose(() => {
      gridPanel = undefined;
      gridPanelReady = false;
      gridPendingMessages.length = 0;
      for (const sid of activeSessions.keys()) {
        disconnectWebSocket(sid);
        processedSessions.delete(sid);
      }
      activeSessions.clear();
    }, null, context.subscriptions);

    panel.webview.html = getGridHtml();
  } else {
    gridPanel.reveal(vscode.ViewColumn.Active);
  }

  if (sessionData) {
    activeSessions.set(sessionId, sessionData);
    updateGridPanelTitle();
    updateDebuggerContent(sessionId, sessionData);
  }
}

function updateDebuggerContent(sessionId: string, sessionData: SessionData) {
  connectToWebSocket(sessionData.debuggerUrl, sessionId, sessionData.testFile);

  const data = {
    resolution: sessionData.resolution,
    url: extractVncUrl(sessionData.debuggerUrl),
    token: 'V3b8wG9',
    testFile: sessionData.testFile || null,
    os: sessionData.os || 'linux'
  };

  const encodedData = Buffer.from(JSON.stringify(data)).toString('base64');
  const sessionUrl = new URL(sessionData.debuggerUrl);
  sessionUrl.searchParams.set('data', encodedData);

  sendToGrid({
    type: 'addSession',
    sessionId,
    url: sessionUrl.toString(),
    title: formatPanelTitle('Running', sessionData.testFile)
  });
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

function connectToWebSocket(debuggerUrl: string, sessionId: string, testFile?: string) {
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
        sendToGrid({ ...message, _gridSessionId: sessionId });

        if (message.event) {
          let status = '';
          switch (message.event) {
            case 'test:start':
              status = 'Running';
              break;
            case 'test:stop':
              status = 'Stopped';
              break;
            case 'test:success':
              status = 'Passed';
              break;
            case 'test:error':
              status = 'Failed';
              break;
            case 'error:fatal':
            case 'error:sdk':
              status = 'Error';
              break;
          }
          if (status) {
            sendToGrid({
              type: 'updateTitle',
              sessionId,
              title: formatPanelTitle(status, testFile)
            });
          }
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    });

    ws.on('close', () => {
      sendToGrid({
        type: 'updateTitle',
        sessionId,
        title: formatPanelTitle('Done', testFile)
      });
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
  for (const sessionId of activeSessions.keys()) {
    disconnectWebSocket(sessionId);
  }
  activeSessions.clear();
  processedSessions.clear();
  if (gridPanel) {
    gridPanel.dispose();
    gridPanel = undefined;
  }
}

// ── MCP Server Installation ────────────────────────────────────────────────

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

  let config: { mcpServers?: Record<string, unknown> } = {};
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

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  if (config.mcpServers['testdriver']) {
    const overwrite = await vscode.window.showWarningMessage(
      'TestDriver MCP is already configured. Overwrite?',
      'Yes',
      'No'
    );
    if (overwrite !== 'Yes') { return; }
  }

  config.mcpServers['testdriver'] = {
    command: 'npx',
    args: ['-y', 'testdriverai', 'mcp'],
    env: {
      TD_API_KEY: '${env:TD_API_KEY}',
      TD_PREVIEW: 'ide'
    }
  };

  try {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(configPath),
      Buffer.from(JSON.stringify(config, null, 2))
    );
    vscode.window.showInformationMessage(
      `TestDriver MCP installed successfully at ${configPath}. Don't forget to set your TD_API_KEY environment variable.`
    );
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
      if (cfg.mcpServers?.['testdriver']) { return; }
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
  } else if (install === 'Never') {
    await config.update('mcpPromptDismissed', true, vscode.ConfigurationTarget.Global);
  }
}

// ── Webview HTML ────────────────────────────────────────────────────────────

function getGridHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://localhost:* https://localhost:*; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>TestDriver Live Preview</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; }
    #waiting {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #cccccc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: center;
    }
    #waiting h1 { font-size: 24px; font-weight: 500; margin-bottom: 16px; }
    #waiting p { font-size: 14px; color: #888; max-width: 400px; line-height: 1.6; }
    #waiting code { background: #2d2d2d; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    .spinner {
      width: 40px; height: 40px;
      border: 3px solid #333; border-top-color: #b0cf34;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 24px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #grid {
      display: none;
      width: 100%;
      height: 100%;
      gap: 4px;
      background: #0d0d0d;
      padding: 4px;
      box-sizing: border-box;
    }
    .cell {
      display: flex;
      flex-direction: column;
      background: #1e1e1e;
      overflow: hidden;
      min-height: 0;
    }
    .cell-header {
      padding: 3px 8px;
      background: #252526;
      color: #cccccc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-shrink: 0;
      border-bottom: 1px solid #3c3c3c;
    }
    .cell iframe {
      flex: 1;
      border: none;
      width: 100%;
      min-height: 0;
    }
  </style>
</head>
<body>
  <div id="waiting">
    <div class="spinner"></div>
    <h1>Waiting for TestDriver...</h1>
    <p>Run a test with <code>preview: "ide"</code> to see the live execution here.</p>
    <p style="margin-top: 16px;"><code>const testdriver = TestDriver(context, { preview: "ide" });</code></p>
  </div>
  <div id="grid"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const grid = document.getElementById('grid');
    const waiting = document.getElementById('waiting');

    function updateGridLayout() {
      const count = grid.children.length;
      if (count === 0) {
        grid.style.display = 'none';
        waiting.style.display = 'flex';
        return;
      }
      waiting.style.display = 'none';
      grid.style.display = 'grid';
      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
      grid.style.gridTemplateRows = 'repeat(' + rows + ', 1fr)';
    }

    window.addEventListener('message', function(event) {
      const msg = event.data;
      if (msg.type === 'addSession') {
        let cell = document.getElementById('cell-' + msg.sessionId);
        if (!cell) {
          cell = document.createElement('div');
          cell.id = 'cell-' + msg.sessionId;
          cell.className = 'cell';
          const header = document.createElement('div');
          header.id = 'header-' + msg.sessionId;
          header.className = 'cell-header';
          header.textContent = msg.title;
          const iframe = document.createElement('iframe');
          iframe.src = msg.url;
          iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
          cell.appendChild(header);
          cell.appendChild(iframe);
          grid.appendChild(cell);
          updateGridLayout();
        }
      } else if (msg.type === 'updateTitle') {
        const header = document.getElementById('header-' + msg.sessionId);
        if (header) { header.textContent = msg.title; }
      } else if (msg.type === 'removeSession') {
        const cell = document.getElementById('cell-' + msg.sessionId);
        if (cell) { cell.remove(); updateGridLayout(); }
      } else if (msg._gridSessionId) {
        const cell = document.getElementById('cell-' + msg._gridSessionId);
        if (cell) {
          const iframe = cell.querySelector('iframe');
          if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage(msg, '*');
          }
        }
      }
    });

    vscode.postMessage({ type: 'ready' });
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
