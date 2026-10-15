'use strict';

/** Journalisation structurée, sans donnée personnelle sensible. */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const REDACT_KEYS = /(password|passwd|secret|token|signature|authorization|cookie|card|cvv|otp|pin)/i;

function redact(value, depth = 0) {
  if (depth > 4) return '[profondeur]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.test(k) ? '[masqué]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[(process.env.LOG_LEVEL || (config.isProduction ? 'info' : 'debug')).toLowerCase()] || 20;

let fileStream = null;
function fileSink() {
  if (config.isProduction) return null;
  try {
    const dir = path.join(config.root, 'data', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    if (!fileStream) fileStream = fs.createWriteStream(path.join(dir, 'app.log'), { flags: 'a' });
    return fileStream;
  } catch {
    return null;
  }
}

function write(level, message, meta) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(meta && Object.keys(meta).length ? { meta: redact(meta) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
  const sink = fileSink();
  if (sink) sink.write(`${line}\n`);
}

module.exports = {
  debug: (m, meta) => write('debug', m, meta),
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
  redact,
};
