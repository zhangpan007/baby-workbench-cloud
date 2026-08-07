#!/usr/bin/env node
'use strict';
/*
 * 宝宝工作台 · 云端同步后端 (Zero-dependency Node.js)
 * -------------------------------------------------------------
 * 提供能力：
 *   GET  /api/status         -> {version, updatedAt, hasData}            (公开)
 *   GET  /api/data           -> {version, updatedAt, data}              (公开·只读，家人查看)
 *   GET  /api/stream         -> SSE 实时推送 data 变更                   (公开·只读)
 *   POST /api/sync           -> {token, data} 写入云端 (需 OWNER_TOKEN)  (仅管理员)
 *   POST /api/reset          -> {token}        清空云端 (需 OWNER_TOKEN) (仅管理员)
 *   /*                       -> 静态托管 public/ 目录
 *
 * 防篡改：所有写操作必须携带与服务器一致的 OWNER_TOKEN；
 * 只读分享链接 (?view=1) 打开的页面不持有令牌，无法修改云端数据。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// 管理口令：部署时通过环境变量设置，家庭成员不知道则永远只能只读
const OWNER_TOKEN = process.env.OWNER_TOKEN || 'baby-cloud-owner';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 内存中的权威数据副本（启动时从磁盘恢复）
let store = { data: null, version: 0, updatedAt: null };
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw && typeof raw === 'object') store = raw;
  } catch (e) { /* 损坏则忽略，保持空 */ }
}
if (typeof store.version !== 'number') store.version = 0;
if (!('data' in store)) store.data = null;

const clients = []; // SSE 订阅者

// 原子写：先写临时文件再 rename，避免半截写入导致文件损坏
function saveStore() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DATA_FILE);
}

// 向所有订阅者广播最新数据
function broadcast() {
  const payload =
    'event: update\ndata: ' +
    JSON.stringify({ version: store.version, updatedAt: store.updatedAt, data: store.data }) +
    '\n\n';
  for (const c of clients) {
    try { c.res.write(payload); } catch (e) { /* 忽略断开的连接 */ }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // 防目录穿越
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    req.on('data', (c) => {
      body += c; size += c.length;
      if (size > 30 * 1024 * 1024) { req.destroy(); } // 上限 30MB，防滥用
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

function sendJSON(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}

const server = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];

  // ---- SSE 实时流 ----
  if (u === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 3000\n\n');
    const client = { res };
    clients.push(client);
    // 立即推送当前状态
    res.write('event: update\ndata: ' +
      JSON.stringify({ version: store.version, updatedAt: store.updatedAt, data: store.data }) + '\n\n');
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(ping); const i = clients.indexOf(client); if (i >= 0) clients.splice(i, 1); });
    return;
  }

  if (u === '/api/status') {
    sendJSON(res, 200, { version: store.version, updatedAt: store.updatedAt, hasData: !!store.data });
    return;
  }

  // ---- 公开只读数据（家人查看）----
  if (u === '/api/data') {
    sendJSON(res, 200, { version: store.version, updatedAt: store.updatedAt, data: store.data });
    return;
  }

  // ---- 管理员写入（实时上传）----
  if (u === '/api/sync' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { sendJSON(res, 400, { ok: false, error: 'bad_json' }); return; }
    if (!parsed || parsed.token !== OWNER_TOKEN) {
      sendJSON(res, 403, { ok: false, error: 'forbidden' }); // 口令不符：拒绝写入（防篡改核心）
      return;
    }
    if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
      sendJSON(res, 400, { ok: false, error: 'bad_data' }); return;
    }
    store.data = parsed.data;
    store.version = (store.version || 0) + 1;
    store.updatedAt = Date.now();
    saveStore();
    broadcast();
    sendJSON(res, 200, { ok: true, version: store.version, updatedAt: store.updatedAt });
    return;
  }

  // ---- 管理员清空 ----
  if (u === '/api/reset' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed; try { parsed = JSON.parse(body); } catch (e) { sendJSON(res, 400, { ok: false }); return; }
    if (!parsed || parsed.token !== OWNER_TOKEN) { sendJSON(res, 403, { ok: false }); return; }
    store.data = null;
    store.version = (store.version || 0) + 1;
    store.updatedAt = Date.now();
    saveStore();
    broadcast();
    sendJSON(res, 200, { ok: true, version: store.version });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('宝宝工作台云端版已启动: http://localhost:' + PORT + '  (OWNER_TOKEN=' + (OWNER_TOKEN === 'baby-cloud-owner' ? '默认' : '已自定义') + ')');
});
