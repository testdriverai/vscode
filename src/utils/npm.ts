import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

function getJSPath(): string {
  const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  const jsPath = path.join(npmRoot, 'testdriverai', 'index.js');
  if (fs.existsSync(jsPath)) {
    return jsPath;
  } else {
    throw new Error('testdriverai package not found in global npm root.');
  }
}

function getPackageJsonVersion(): string {
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const pkgPath = path.join(npmRoot, 'testdriverai', 'package.json');

    if (!fs.existsSync(pkgPath)) {
      throw new Error('testdriverai is not installed globally.');
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const currentVersion: string = pkg.version;

    return currentVersion;
  } catch (err: unknown) {
    logger.error('Error:', (err as Error).message);
    process.exit(1);
  }
}

function compareVersions(v1: string, v2: string): number {
  const v1Parts = v1.split('.').map(Number);
  const v2Parts = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1Part = v1Parts[i] || 0;
    const v2Part = v2Parts[i] || 0;

    if (v1Part > v2Part) {
      return 1;
    }
    if (v1Part < v2Part) {
      return -1;
    }
  }

  return 0;
}

function getPackagePath(): string {
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const packagePath = path.join(npmRoot, 'testdriverai');
    if (fs.existsSync(packagePath)) {
      return packagePath;
    } else {
      throw new Error('testdriverai package not found in global npm root.');
    }
  } catch {
    throw new Error('Failed to resolve global npm root.');
  }
}

function getNodePath(): string {
  // Try system-wide Node.js installations first to avoid NVM wrapper issues
  const systemPaths = [
    '/usr/bin/node',
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node'
  ];

  for (const nodePath of systemPaths) {
    if (fs.existsSync(nodePath)) {
      try {
        // Verify it's actually a working Node.js executable
        execSync(`"${nodePath}" --version`, { stdio: 'pipe' });
        return fs.realpathSync(nodePath);
      } catch {
        continue;
      }
    }
  }

  try {
    // Fall back to which/where command
    let nodePath = process.platform === 'win32'
      ? execSync('where node', { encoding: 'utf8' }).trim().split('\n')[0]
      : execSync('which node', { encoding: 'utf8' }).trim();

    // Resolve symlinks to get the actual binary
    try {
      nodePath = fs.realpathSync(nodePath);
    } catch {
      // If realpath fails, use the original path
    }

    if (fs.existsSync(nodePath)) {
      return nodePath;
    }
  } catch {
    // Continue to fallback options
  }

  // Try using process.execPath but only if it's actually node
  if (process.execPath && process.execPath.includes('node')) {
    try {
      const realPath = fs.realpathSync(process.execPath);
      if (fs.existsSync(realPath) && realPath.includes('node')) {
        return realPath;
      }
    } catch {
      // Continue to fallback options
    }
  }

  throw new Error('Node.js executable not found');
}

export { getPackageJsonVersion, compareVersions, getPackagePath, getJSPath, getNodePath };
