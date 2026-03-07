'use strict';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const DEFAULT_LEVEL = 'info';

function createLogger(serviceName) {
  const levelIndex = LEVELS.indexOf((process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase());
  const effectiveLevel = levelIndex >= 0 ? levelIndex : LEVELS.indexOf(DEFAULT_LEVEL);

  function log(level, message, extra = {}) {
    const idx = LEVELS.indexOf(level);
    if (idx < 0 || idx < effectiveLevel) return;

    const entry = {
      level,
      timestamp: new Date().toISOString(),
      service: serviceName,
      message,
      ...extra,
    };
    const out = JSON.stringify(entry);
    if (level === 'error') {
      console.error(out);
    } else {
      console.log(out);
    }
  }

  return {
    debug(msg, extra) { log('debug', msg, extra); },
    info(msg, extra) { log('info', msg, extra); },
    warn(msg, extra) { log('warn', msg, extra); },
    error(msg, extra) { log('error', msg, extra); },
  };
}

module.exports = { createLogger };
