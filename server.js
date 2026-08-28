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
 *
 * 持久化（关键）：
 *   当设置了 GITHUB_TOKEN 时，权威数据存到 GitHub 仓库文件 cloud-data/store.json
 *   （AES-256-GCM 加密，仓库即使公开也看不到明文），因此 Render 免费版磁盘
 *   临时重置/休眠/重新部署都不会丢数据。未设置 GITHUB_TOKEN 时回退到本地
 *   data/store.json（用于本地开发），并作为线上的一份缓存兜底。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// 管理口令：部署时通过环境变量设置，家庭成员不知道则永远只能只读
const OWNER_TOKEN = process.env.OWNER_TOKEN || 'baby-cloud-owner';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- GitHub 持久化配置 ----
const USE_GITHUB = !!process.env.GITHUB_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'zhangpan007/baby-workbench-cloud';
const GITHUB_DATA_PATH = process.env.GITHUB_DATA_PATH || 'cloud-data/store.json';
// 诊断：记录最后一次 GitHub 写入结果，便于线上排查 token/权限问题
const ghDiag = { lastOk: null, lastStatus: 0, lastErr: '', lastAt: 0 };
function tokenMask(t) {
  if (!t) return '(empty)';
  if (t.length <= 12) return t.length + ' chars (too short)';
  return t.slice(0, 12) + '…' + t.slice(-4) + ' (len=' + t.length + ')';
}
// 加密密钥：优先用专用密钥，缺失时回退 OWNER_TOKEN，保证本地/线上都能跑
const DATA_ENC_KEY = process.env.DATA_ENC_KEY || OWNER_TOKEN;
const GH_HEADERS = {
  'Authorization': 'Bearer ' + GITHUB_TOKEN,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'baby-workbench-server',
  'Content-Type': 'application/json'
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 内存中的权威数据副本（启动时从磁盘/仓库恢复）
let store = { data: null, version: 0, updatedAt: null };
const clients = []; // SSE 订阅者

// ---------------- 本地文件缓存（兜底 / 本地开发） ----------------
function readLocalStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch (e) { /* 损坏则忽略 */ }
  return null;
}

// 原子写：先写临时文件再 rename，避免半截写入导致文件损坏
function writeLocalStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { /* 本地写失败不影响 GitHub 权威存储 */ }
}

// ---------------- 加密（AES-256-GCM） ----------------
function encKeyBuf() {
  return crypto.scryptSync(DATA_ENC_KEY, 'baby-workbench-salt-v1', 32);
}
function encryptObj(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKeyBuf(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'ENC1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptStr(str) {
  const buf = Buffer.from(str, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKeyBuf(), iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  return JSON.parse(json);
}

// ---------------- GitHub Contents API ----------------
// 关键加固：不使用全局 fetch / undici（在 Render 等受限环境对 api.github.com
// 的请求可能永久挂起且 AbortController 无法及时中断，常见原因是 IPv6 解析死连）。
// 改用原生 https 模块，强制 IPv4（family:4）并设硬性 8 秒 socket 超时，确保
// 任何情况下请求都会以失败或成功收尾，绝不会无限挂起堵死串行写入队列。
const GH_TIMEOUT_MS = 8000;
function githubApi(method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = Object.assign({}, GH_HEADERS);
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/' + GITHUB_REPO + '/contents/' + GITHUB_DATA_PATH,
      method: method,
      family: 4, // 强制 IPv4，规避 IPv6 死连
      headers: headers
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          json: () => Promise.resolve(buf ? JSON.parse(buf) : {}),
          text: () => Promise.resolve(buf)
        });
      });
    });
    // 关键：独立的外部定时器。仅用 req.setTimeout 无法覆盖 DNS 解析阶段的挂死
    // （此时尚未建立 socket），必须主动 destroy 才能在超时后 reject，避免无限挂起。
    // 关键：定时器直接 reject，而非仅依赖 req.destroy() 触发 'error' 事件。
    // 在 Render 等环境实测 req.destroy() 在连接/TLS 挂死阶段不会可靠地 emit 'error'，
    // 导致 Promise 永远 pending；直接 reject 才能保证超时后必然收尾。
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch (e) {}
      reject(new Error('GitHub request timeout'));
    }, GH_TIMEOUT_MS);
    req.on('error', (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); });
    if (payload) req.write(payload);
    req.end();
  });
}

let githubSha = null; // 当前文件 SHA，用于更新时避免 409 冲突

async function githubRead() {
  try {
    const r = await githubApi('GET');
    if (r.status === 404) return null;            // 文件不存在（首次）
    if (r.status === 403) { console.error('[GH] 读取被限流或无权限(status 403)'); return null; }
    if (!r.ok) { console.error('[GH] 读取失败 status', r.status); return null; }
    const j = await r.json();
    githubSha = j.sha;
    const raw = Buffer.from(j.content, 'base64').toString('utf8');
    if (raw.startsWith('ENC1:')) return decryptStr(raw.slice(5));
    return JSON.parse(raw); // 兼容未加密旧内容
  } catch (e) {
    console.error('[GH] 读取异常', e.message);
    return null;
  }
}

// 串行化写入，避免并发更新互相覆盖
let ghWriteQueue = Promise.resolve();
let ghWriteAttempts = 0; // 同步计数器：确认 githubWrite 是否被调用（不依赖异步结果）
function githubWrite(obj) {
  ghWriteAttempts++;
  ghWriteQueue = ghWriteQueue.then(() => _githubWriteOnce(obj)).catch(() => {});
  return ghWriteQueue;
}
async function _githubWriteOnce(obj) {
  const content = encryptObj(obj);
  let lastBody = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { message: 'sync: update baby-workbench store', content };
    if (githubSha) body.sha = githubSha; // 存在则带 SHA 更新
    else console.error('[GH] 警告：githubSha 为空，将导致 422');
    try {
      const r = await githubApi('PUT', body);
      if (r.ok) {
        const j = await r.json();
        githubSha = j.content.sha;
        ghDiag.lastOk = true; ghDiag.lastStatus = r.status; ghDiag.lastErr = ''; ghDiag.lastAt = Date.now();
        return true;
      }
      if (r.status === 409 || r.status === 422) {
        // 冲突或缺少 SHA：记录响应体并重新拉取最新 SHA 后重试
        lastBody = await r.text().catch(() => '');
        console.error('[GH] 写入 409/422 attempt', attempt, 'githubSha=', githubSha ? githubSha.slice(0, 8) : '(null)', lastBody.slice(0, 200));
        await githubRead();
        continue;
      }
      const txt = await r.text().catch(() => '');
      ghDiag.lastOk = false; ghDiag.lastStatus = r.status; ghDiag.lastErr = txt.slice(0, 200); ghDiag.lastAt = Date.now();
      console.error('[GH] 写入失败 status', r.status, txt.slice(0, 200));
      return false;
    } catch (e) {
      console.error('[GH] 写入异常 attempt', attempt, e.message);
      // 超时 / 网络错误（如 DNS 阶段挂死）可能是间歇性的，重试一次
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 600)); continue; }
      ghDiag.lastOk = false; ghDiag.lastStatus = 0; ghDiag.lastErr = e.message; ghDiag.lastAt = Date.now();
      return false;
    }
  }
  // 循环耗尽（多为反复 409/422）：记录最后一次响应体便于排查
  ghDiag.lastOk = false; ghDiag.lastStatus = 422; ghDiag.lastErr = 'exhausted: ' + lastBody.slice(0, 200); ghDiag.lastAt = Date.now();
  return false;
}

// ---------------- 统一读写入口 ----------------
function saveStore() {
  writeLocalStore();                 // 本地缓存（兜底）
  if (USE_GITHUB) githubWrite(store); // GitHub 权威持久化（异步、串行）
}

async function loadInitialStore() {
  if (USE_GITHUB) {
    const gh = await githubRead();
    if (gh && (gh.data || gh.version)) { store = gh; return; }
    // GitHub 为空：用本地缓存播种（迁移旧数据 / 兜底）
    const local = readLocalStore();
    if (local && (local.data || local.version)) {
      store = local;
      await githubWrite(store);
      return;
    }
  }
  store = readLocalStore() || { data: null, version: 0, updatedAt: null };
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
    sendJSON(res, 200, {
      version: store.version, updatedAt: store.updatedAt, hasData: !!store.data, githubMode: USE_GITHUB,
      serverBuild: 'fix4-direct-reject',
      gh: {
        repo: GITHUB_REPO, path: GITHUB_DATA_PATH,
        tokenMask: USE_GITHUB ? tokenMask(GITHUB_TOKEN) : '(no token)',
        writeAttempts: ghWriteAttempts,
        lastWriteOk: ghDiag.lastOk, lastWriteStatus: ghDiag.lastStatus,
        lastWriteErr: ghDiag.lastErr, lastWriteAt: ghDiag.lastAt
      }
    });
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

  // 临时诊断：直接测 GitHub 连通性 + 真实写入路径（带 sha 与真实加密载荷）
  if (u === '/api/ghtest') {
    (async () => {
      const out = { githubMode: USE_GITHUB, hasData: !!store.data, sha: githubSha ? githubSha.slice(0, 8) : null };
      try {
        const r = await githubApi('GET');
        out.get = { ok: r.ok, status: r.status };
      } catch (e) { out.get = { error: e.message }; }
      try {
        const ok = await _githubWriteOnce(store);
        out.writeResult = ok;
        out.diag = { lastOk: ghDiag.lastOk, status: ghDiag.lastStatus, err: ghDiag.lastErr };
      } catch (e) { out.writeError = e.message; }
      sendJSON(res, 200, out);
    })();
    return;
  }

  serveStatic(req, res);
});

async function start() {
  await loadInitialStore();
  // sanity
  if (typeof store.version !== 'number') store.version = 0;
  if (!('data' in store)) store.data = null;
  // 启动后强制把（可能来自明文种子的）数据以加密格式写回 GitHub，并刷新 SHA；
  // 同时作为写入链路的冒烟测试，避免「内存有数据、GitHub 永远 404」的静默故障
  if (USE_GITHUB && store.data) {
    githubWrite(store);
  }
  server.listen(PORT, () => {
    const mode = USE_GITHUB ? ('GitHub 持久化 -> ' + GITHUB_REPO + '/' + GITHUB_DATA_PATH) : '本地文件回退';
    console.log('宝宝工作台云端版已启动: http://localhost:' + PORT +
      '  (OWNER_TOKEN=' + (OWNER_TOKEN === 'baby-cloud-owner' ? '默认' : '已自定义') + ')  存储=' + mode);
  });
}

start();
