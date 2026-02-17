import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import WebSocket from 'ws';

// Store active debugger panels by session ID
const debuggerPanels: Map<string, vscode.WebviewPanel> = new Map();
const websocketConnections: Map<string, WebSocket> = new Map();
let processedSessions: Set<string> = new Set();

// File watchers for .testdriver/.previews/ in each workspace folder
const previewWatchers: Map<string, vscode.FileSystemWatcher> = new Map();

// Local HTTP server for receiving session notifications from SDK
let httpServer: http.Server | undefined;
let serverPort: number | undefined;

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

export function activate(context: vscode.ExtensionContext) {
  console.log('TestDriver.ai extension is now active');

  // Ensure directories exist
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
  if (!fs.existsSync(INSTANCES_DIR)) {
    fs.mkdirSync(INSTANCES_DIR, { recursive: true });
  }

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
    }
  });

  httpServer.on('error', (error) => {
    console.error('HTTP server error:', error);
  });
}

function registerInstance() {
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
    fs.writeFileSync(registrationFile, JSON.stringify(registration, null, 2));
    console.log(`Registered VS Code instance: ${registrationFile}`);
  } catch (error) {
    console.error('Failed to register instance:', error);
  }
}

function unregisterInstance() {
  const registrationFile = path.join(INSTANCES_DIR, `${instanceId}.json`);
  try {
    if (fs.existsSync(registrationFile)) {
      fs.unlinkSync(registrationFile);
    }
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

function setupPreviewWatchers(context: vscode.ExtensionContext) {
  for (const [, watcher] of previewWatchers) {
    watcher.dispose();
  }
  previewWatchers.clear();

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) { return; }

  for (const folder of workspaceFolders) {
    const previewsDir = path.join(folder.uri.fsPath, '.testdriver', '.previews');

    if (!fs.existsSync(previewsDir)) {
      try {
        fs.mkdirSync(previewsDir, { recursive: true });
      } catch (error) {
        console.error(`Failed to create previews directory: ${error}`);
        continue;
      }
    }

    const pattern = new vscode.RelativePattern(folder, '.testdriver/.previews/*.json');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate((uri) => handlePreviewFile(context, uri));
    watcher.onDidChange((uri) => handlePreviewFile(context, uri));

    previewWatchers.set(folder.uri.fsPath, watcher);
    context.subscriptions.push(watcher);

    cleanupStalePreviewFiles(previewsDir);
  }
}

function cleanupStalePreviewFiles(previewsDir: string) {
  try {
    const files = fs.readdirSync(previewsDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(previewsDir, file));
        } catch { /* ignore */ }
      }
    }
  } catch { /* directory might not exist */ }
}

function handlePreviewFile(context: vscode.ExtensionContext, uri: vscode.Uri) {
  try {
    const content = fs.readFileSync(uri.fsPath, 'utf-8');
    if (!content.trim()) { return; }

    const sessionData: SessionData = JSON.parse(content);
    if (!sessionData.sessionId) {
      sessionData.sessionId = path.basename(uri.fsPath, '.json');
    }

    if (processedSessions.has(sessionData.sessionId)) { return; }

    handleSessionNotification(context, sessionData);

    try { fs.unlinkSync(uri.fsPath); } catch { /* ignore */ }
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
    vscode.ViewColumn.Beside,
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
    const wsUrl = `ws://${url.host}`;
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

  let configPath = mcpConfigPaths.find(p => fs.existsSync(p));

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

  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (error) {
      vscode.window.showErrorMessage(`Error reading MCP config: ${error}`);
      return;
    }
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
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (cfg.mcpServers?.['testdriver']) { return; }
      } catch { /* ignore */ }
    }
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
