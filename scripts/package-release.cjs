'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const version = '0.2.0-dev.2';

function releaseEntries() {
  return ['native', 'packages', 'examples', 'docs', 'README.md', 'LICENSE'];
}

function assertAllowedEntry(entry) {
  const normalized = String(entry).replaceAll('\\', '/').replace(/^\.\//, '');
  const lower = normalized.toLowerCase();
  const segments = lower.split('/');
  const deniedSegments = new Set([
    'archive', 'node_modules', 'schema', 'save', 'saves', 'backups',
    'build', 'build-active', '__pycache__', '.requirements',
  ]);
  if (segments.some((segment) => deniedSegments.has(segment)) ||
      /\.(obj|pdb|log|bin|gz|xml|pyc)$/i.test(lower)) {
    throw new Error(`Release entry is not allowed: ${entry}`);
  }

  if (normalized === 'README.md' || normalized === 'LICENSE' ||
      normalized === 'SHA256SUMS.txt') return true;
  const [area] = segments;
  if (!['native', 'packages', 'examples', 'docs'].includes(area)) {
    throw new Error(`Release entry is not allowed: ${entry}`);
  }
  if (area === 'native' && !/^native\/(cfb27_lua_host|cryptbase)\.dll$/i.test(normalized)) {
    throw new Error(`Release entry is not allowed: ${entry}`);
  }
  if (area === 'packages' && !normalized.endsWith('.tgz')) {
    throw new Error(`Release entry is not allowed: ${entry}`);
  }
  if (area === 'docs' && !normalized.endsWith('.md')) {
    throw new Error(`Release entry is not allowed: ${entry}`);
  }
  if (area === 'examples' && !/\.(lua|md)$/i.test(normalized)) {
    throw new Error(`Release entry is not allowed: ${entry}`);
  }
  return true;
}

async function walkFiles(directory, relative = '') {
  const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(directory, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex').toUpperCase();
}

async function normalizeMtimes(directory) {
  if (!process.env.SOURCE_DATE_EPOCH) return;
  const seconds = Number(process.env.SOURCE_DATE_EPOCH);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('SOURCE_DATE_EPOCH is invalid');
  const date = new Date(seconds * 1000);
  for (const file of await walkFiles(directory)) {
    await fs.utimes(path.join(directory, file), date, date);
  }
}

async function copyTreeIfPresent(source, destination) {
  try {
    await fs.access(source);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await fs.cp(source, destination, { recursive: true });
}

async function packWorkspace(workspace, destination, outputName) {
  await fs.mkdir(destination, { recursive: true });
  if (!process.env.npm_execpath) {
    throw new Error('Run the preview packager through npm run pack:preview');
  }
  const stdout = childProcess.execFileSync(
    process.execPath,
    [process.env.npm_execpath, 'pack', '--workspace', workspace,
      '--pack-destination', destination, '--json'],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || !result[0]?.filename) throw new Error(`npm pack failed for ${workspace}`);
  const source = path.join(destination, result[0].filename);
  const output = path.join(destination, outputName);
  if (source !== output) await fs.rename(source, output);
  return output;
}

async function main({ artifactsDir } = {}) {
  const configuredArtifactsDir = artifactsDir || process.env.CFB27_NATIVE_ARTIFACTS;
  if (!configuredArtifactsDir) {
    throw new Error('Provide artifactsDir or set CFB27_NATIVE_ARTIFACTS to the native Release directory');
  }
  const dist = path.join(root, 'dist');
  const stage = path.join(dist, `cfb27-lua-hook-${version}`);
  const nativeSource = path.resolve(configuredArtifactsDir);
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(path.join(stage, 'native'), { recursive: true });
  await fs.mkdir(path.join(stage, 'packages'), { recursive: true });

  await fs.copyFile(
    path.join(nativeSource, 'cfb27_lua_host.dll'),
    path.join(stage, 'native', 'cfb27_lua_host.dll'),
  );
  await fs.copyFile(
    path.join(nativeSource, 'cfb27_cryptbase_proxy.dll'),
    path.join(stage, 'native', 'CryptBase.dll'),
  );

  const sdkPackDir = path.join(dist, '.pack-sdk');
  const cliPackDir = path.join(dist, '.pack-cli');
  const sdkPackage = await packWorkspace(
    'packages/sdk', sdkPackDir, `cfb27-lua-hook-sdk-${version}.tgz`,
  );
  const cliPackage = await packWorkspace(
    'packages/cli', cliPackDir, `cfb27-lua-hook-${version}.tgz`,
  );
  await fs.copyFile(sdkPackage, path.join(stage, 'packages', path.basename(sdkPackage)));
  await fs.copyFile(cliPackage, path.join(stage, 'packages', path.basename(cliPackage)));
  await fs.rm(sdkPackDir, { recursive: true, force: true });
  await fs.rm(cliPackDir, { recursive: true, force: true });

  await copyTreeIfPresent(path.join(root, 'examples'), path.join(stage, 'examples'));
  await copyTreeIfPresent(path.join(root, 'docs'), path.join(stage, 'docs'));
  await fs.copyFile(path.join(root, 'README.md'), path.join(stage, 'README.md'));
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  await normalizeMtimes(stage);

  const files = await walkFiles(stage);
  for (const file of files) assertAllowedEntry(file);
  const checksumLines = [];
  for (const file of files) {
    checksumLines.push(`${await sha256File(path.join(stage, file))}  ${file.replaceAll('\\', '/')}`);
  }
  await fs.writeFile(path.join(stage, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`, 'utf8');

  const zip = path.join(dist, `cfb27-lua-hook-${version}.zip`);
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  childProcess.execFileSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -Path $env:CFB27_STAGE -DestinationPath $env:CFB27_ZIP -CompressionLevel Optimal'],
    {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, CFB27_STAGE: stage, CFB27_ZIP: zip },
      stdio: 'inherit',
    },
  );
  const zipHash = await sha256File(zip);
  await fs.writeFile(
    path.join(dist, 'SHA256SUMS.txt'),
    `${zipHash}  ${path.basename(zip)}\n`,
    'utf8',
  );
  return { stage, zip, sha256: zipHash };
}

if (require.main === module) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { releaseEntries, assertAllowedEntry, main };
