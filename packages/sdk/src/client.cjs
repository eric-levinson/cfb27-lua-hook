'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { Cfb27HookError } = require('./errors.cjs');
const { encodeFrame, FrameDecoder } = require('./frame.cjs');
const { discoverGame } = require('./process.cjs');

function createClient({ pid, pipeName, timeoutMs = 3000 } = {}) {
  if (!pipeName && (!Number.isInteger(pid) || pid <= 0)) {
    throw new Cfb27HookError('INVALID_REQUEST', 'createClient requires a positive PID or pipe name');
  }
  const resolvedPipeName = pipeName || `\\\\.\\pipe\\CFB27LuaHost.v1.${pid}`;

  function request(command, params = {}) {
    if (typeof command !== 'string' || !command || !params || typeof params !== 'object') {
      return Promise.reject(new Cfb27HookError('INVALID_REQUEST', 'Command and params are invalid'));
    }

    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const decoder = new FrameDecoder();
      const socket = net.createConnection(resolvedPipeName);
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Cfb27HookError('PIPE_TIMEOUT', `Host did not respond within ${timeoutMs} ms`, {
          pipeName: resolvedPipeName,
        }));
      }, timeoutMs);

      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      }

      socket.once('connect', () => {
        try {
          socket.write(encodeFrame({ protocol: 1, id, command, params }));
        } catch (error) {
          finish(error);
        }
      });
      socket.on('data', (chunk) => {
        let responses;
        try {
          responses = decoder.push(chunk);
        } catch (error) {
          finish(error);
          return;
        }
        for (const response of responses) {
          if (!response || response.protocol !== 1) {
            finish(new Cfb27HookError('PROTOCOL_MISMATCH', 'Host protocol version does not match'));
            return;
          }
          if (response.id !== id || typeof response.ok !== 'boolean') {
            finish(new Cfb27HookError('INVALID_RESPONSE', 'Host response does not match the request'));
            return;
          }
          if (!response.ok) {
            const hostError = response.error || {};
            finish(new Cfb27HookError(
              typeof hostError.code === 'string' ? hostError.code : 'INVALID_RESPONSE',
              typeof hostError.message === 'string' ? hostError.message : 'Host request failed',
              hostError.details,
            ));
            return;
          }
          finish(null, response.result);
          return;
        }
      });
      socket.once('end', () => {
        if (!settled) finish(new Cfb27HookError('INVALID_RESPONSE', 'Host closed without a response'));
      });
      socket.once('error', (error) => {
        finish(new Cfb27HookError('HOST_NOT_READY', 'Could not connect to the Lua host', {
          pipeName: resolvedPipeName,
          cause: error.message,
        }));
      });
    });
  }

  return Object.freeze({
    request,
    async hello() {
      const result = await request('hello');
      if (!result || result.protocolVersion !== 1) {
        throw new Cfb27HookError('PROTOCOL_MISMATCH', 'Host protocol version does not match');
      }
      return result;
    },
    status() {
      return request('status');
    },
    runScript({ name, source } = {}) {
      return request('runScript', { name, source });
    },
    evaluateLua(source) {
      return request('evaluate', { source });
    },
  });
}

async function resolvePid(options) {
  if (Number.isInteger(options.pid) && options.pid > 0) return options.pid;
  return (await discoverGame(options)).pid;
}

async function getHostStatus(options = {}) {
  const pid = await resolvePid(options);
  const client = createClient({ pid, pipeName: options.pipeName, timeoutMs: options.timeoutMs });
  const hello = await client.hello();
  if (!Array.isArray(hello.capabilities) || !hello.capabilities.includes('status')) {
    throw new Cfb27HookError('PROTOCOL_MISMATCH', 'Host does not advertise status capability');
  }
  return client.status();
}

async function runScriptFile(filePath, options = {}) {
  const source = await fs.readFile(filePath, 'utf8');
  const pid = await resolvePid(options);
  const client = createClient({ pid, pipeName: options.pipeName, timeoutMs: options.timeoutMs });
  return client.runScript({ name: path.basename(filePath), source });
}

module.exports = { createClient, getHostStatus, runScriptFile };
