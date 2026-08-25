'use strict';

/**
 * Preload for MCP servers launched through npx on Windows.
 *
 * Node cannot spawn `.cmd` shims directly (spawn npx.cmd fails with EINVAL).
 * This preload routes .cmd/.bat commands through cmd.exe with argument
 * escaping, without shell-expanding untrusted input. It is self-contained so
 * the packaged app does not need to copy npm transitive dependencies.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const originalSpawn = childProcess.spawn.bind(childProcess);
const originalSpawnSync = childProcess.spawnSync.bind(childProcess);

// Cross-spawn escaping algorithm (MIT), kept here to avoid a runtime
// dependency inside the packaged resources directory.
const metaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(value) {
  return value.replace(metaCharsRegExp, '^$1');
}

function escapeArgument(value, doubleEscapeMetaChars) {
  let arg = `${value}`;
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1');
  arg = `"${arg}"`;
  arg = arg.replace(metaCharsRegExp, '^$1');
  if (doubleEscapeMetaChars) {
    arg = arg.replace(metaCharsRegExp, '^$1');
  }
  return arg;
}

function isWindows() {
  return process.platform === 'win32';
}

function resolveExecutable(command, env) {
  if (!isWindows() || path.isAbsolute(command) || /^[A-Za-z]:[\\/]/.test(command)) {
    return command;
  }
  if (command.includes('/') || command.includes('\\')) {
    return command;
  }

  const pathValue = env.PATH || env.Path || '';
  const pathExt = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const extensions = pathExt
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
  const candidates = [];

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const base = path.join(dir, command);
    candidates.push(base);
    for (const ext of extensions) {
      candidates.push(`${base}${ext}`);
    }
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return command;
}

function isCmdShim(command) {
  if (!isWindows()) return false;
  const ext = path.extname(command).toLowerCase();
  return ext === '.cmd' || ext === '.bat' || /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i.test(command);
}

function buildCmdInvocation(executable, args, options) {
  const needsDoubleEscape = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i.test(executable);
  const shellCommand = [
    escapeCommand(executable),
    ...args.map((value) => escapeArgument(value, needsDoubleEscape)),
  ].join(' ');
  return {
    command: process.env.comspec || process.env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    options: { ...options, windowsVerbatimArguments: true },
  };
}

function normalizeArgs(args, options) {
  if (args === undefined) return { args: [], options: options || {} };
  if (!Array.isArray(args)) return { args: [], options: args || {} };
  return { args, options: options || {} };
}

function bridgeSpawn(command, args, options) {
  if (!isWindows() || command === undefined || command === null) {
    return originalSpawn(command, args, options);
  }
  const normalized = normalizeArgs(args, options);
  const executable = resolveExecutable(command, normalized.options.env || process.env);
  if (!normalized.options.shell && isCmdShim(executable)) {
    const invocation = buildCmdInvocation(executable, normalized.args, normalized.options);
    return originalSpawn(invocation.command, invocation.args, invocation.options);
  }
  return originalSpawn(executable, normalized.args, normalized.options);
}

function bridgeSpawnSync(command, args, options) {
  if (!isWindows() || command === undefined || command === null) {
    return originalSpawnSync(command, args, options);
  }
  const normalized = normalizeArgs(args, options);
  const executable = resolveExecutable(command, normalized.options.env || process.env);
  if (!normalized.options.shell && isCmdShim(executable)) {
    const invocation = buildCmdInvocation(executable, normalized.args, normalized.options);
    return originalSpawnSync(invocation.command, invocation.args, invocation.options);
  }
  return originalSpawnSync(executable, normalized.args, normalized.options);
}

childProcess.spawn = bridgeSpawn;
childProcess.spawnSync = bridgeSpawnSync;
