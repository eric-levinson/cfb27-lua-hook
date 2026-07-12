'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compileFrtkArtifacts } = require('../packages/sdk/src/frtk-profile.cjs');
const { canonicalStringify } = require('../packages/sdk/src/validation.cjs');

const root = path.resolve(__dirname, '..');
const privateRoot = path.join(root, '.frtk');

function parseArguments(argv) {
  const result = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force') {
      if (result.force) throw new Error('Duplicate argument: --force');
      result.force = true;
      continue;
    }
    if (!['--snapshot', '--layout', '--output'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const key = argument.slice(2);
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    result[key] = value;
    index += 1;
  }
  for (const key of ['snapshot', 'layout', 'output']) {
    if (!result[key]) throw new Error(`Missing required argument: --${key}`);
  }
  return result;
}

function isOutsidePrivateRoot(resolvedRoot, resolved) {
  const relative = path.relative(resolvedRoot, resolved);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

function resolvePrivatePath(value, name, { follow = false } = {}) {
  const resolved = path.resolve(root, value);
  if (isOutsidePrivateRoot(privateRoot, resolved)) {
    throw new Error(`${name} must resolve to a file inside the repository .frtk directory`);
  }
  if (follow) {
    const realPrivateRoot = fs.realpathSync(privateRoot);
    const realResolved = fs.realpathSync(resolved);
    if (isOutsidePrivateRoot(realPrivateRoot, realResolved)) {
      throw new Error(`${name} must resolve to a file inside the repository .frtk directory`);
    }
    return realResolved;
  }
  return resolved;
}

function prepareOutputPath(outputPath) {
  let existingAncestor = path.dirname(outputPath);
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error('Could not find an existing ancestor for --output');
    }
    existingAncestor = parent;
  }
  const realPrivateRoot = fs.realpathSync(privateRoot);
  if (isOutsidePrivateRoot(realPrivateRoot, fs.realpathSync(existingAncestor))) {
    throw new Error('--output must resolve to a file inside the repository .frtk directory');
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const realParent = fs.realpathSync(path.dirname(outputPath));
  if (isOutsidePrivateRoot(realPrivateRoot, realParent)) {
    throw new Error('--output must resolve to a file inside the repository .frtk directory');
  }
  if (fs.existsSync(outputPath) &&
      isOutsidePrivateRoot(realPrivateRoot, fs.realpathSync(outputPath))) {
    throw new Error('--output must resolve to a file inside the repository .frtk directory');
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const snapshotPath = resolvePrivatePath(options.snapshot, '--snapshot', { follow: true });
  const layoutPath = resolvePrivatePath(options.layout, '--layout', { follow: true });
  const outputPath = resolvePrivatePath(options.output, '--output');
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  const artifacts = compileFrtkArtifacts({ snapshot, layout });
  prepareOutputPath(outputPath);
  fs.writeFileSync(outputPath, `${canonicalStringify(artifacts)}\n`, {
    encoding: 'utf8',
    flag: options.force ? 'w' : 'wx',
  });
  process.stdout.write(`${outputPath}\n`);
  return artifacts;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArguments, resolvePrivatePath, prepareOutputPath, main };
