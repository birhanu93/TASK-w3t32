/**
 * Creates a test Koa app with a mockable DB layer.
 * We build the app from scratch (mirroring src/index.js) but with db stubbed.
 *
 * Usage:
 *   const { createTestApp, request } = require('./testApp');
 *   const app = createTestApp(mockDb);
 *   const res = await request(app, 'GET', '/health');
 */

const http = require('http');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const json = require('koa-json');
const errorHandler = require('../../src/middleware/errorHandler');
const { auditMiddleware } = require('../../src/middleware/audit');

/**
 * Make an HTTP request to a Koa app. Returns { status, headers, body }.
 */
async function request(app, method, path, { body, headers = {} } = {}) {
  const server = http.createServer(app.callback());
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const url = `http://localhost:${port}${path}`;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    let data;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return { status: res.status, headers: Object.fromEntries(res.headers), body: data };
  } finally {
    server.close();
  }
}

module.exports = { request };
