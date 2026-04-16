const pino = require('pino');
const config = require('../config');
const path = require('path');
const fs = require('fs');

const logDir = path.join(config.dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });

let logger;

if (config.env === 'test') {
  logger = pino({ level: 'silent' });
} else if (config.env === 'development') {
  logger = pino({
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level(label) { return { level: label }; } },
    transport: { target: 'pino-pretty', options: { colorize: true } },
  });
} else {
  // Production: write structured JSON logs to a durable file + stdout
  const logFilePath = path.join(logDir, 'app.log');
  const logStream = pino.multistream([
    { stream: process.stdout },
    { stream: fs.createWriteStream(logFilePath, { flags: 'a' }) },
  ]);
  logger = pino({
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level(label) { return { level: label }; } },
  }, logStream);
}

module.exports = logger;
