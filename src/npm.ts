import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

function getExecutablePath(): string {
  try {
    const cmd = process.platform === 'win32' ? 'where testdriverai' : 'which testdriverai';
    const resolvedPath = execSync(cmd, { encoding: 'utf8' }).split('\n')[0].trim();
    if (fs.existsSync(resolvedPath)) {
      return resolvedPath;
    } else {
      throw new Error('Binary found but does not exist on disk.');
    }
  } catch (err) {
    throw new Error('testdriverai executable not found in PATH.');
  }
}

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
  } catch (err: any) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

function compareVersions(v1: string, v2: string): number {
  const v1Parts = v1.split('.').map(Number);
  const v2Parts = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1Part = v1Parts[i] || 0;
    const v2Part = v2Parts[i] || 0;

    if (v1Part > v2Part) return 1;
    if (v1Part < v2Part) return -1;
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
  } catch (err) {
    throw new Error('Failed to resolve global npm root.');
  }
}

export { getExecutablePath, getPackageJsonVersion, compareVersions, getPackagePath, getJSPath };
