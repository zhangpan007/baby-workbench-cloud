# 👶 宝宝工作台 · 云端同步版

把单文件孕期/宝宝花销台账升级为**云端账号绑定的多端实时同步应用**：

- ☁️ **单一云端账号**：电脑客户端 与 Safari 桌面 PWA 输入**同一个 OWNER_TOKEN**，即视为同一账号，两端数据实时互相同步。
- ⚡ **实时上传**：任何修改在 400ms 内推送云端。
- 🔄 **多端统一刷新**：所有打开的设备通过 SSE 实时刷新最新数据（无论在哪编辑）。
- 👀 **家人只读分享**：把 `?view=1` 链接发给家人，自动进入**只读 + 实时 + 防篡改**视图（服务器校验口令，无令牌无法写入）。
- 📲 **PWA 安装**：支持 Safari 桌面「添加到程序坞」、手机「添加到主屏幕」，离线也能看最近一次数据。

---

## 一、本地运行（立即可用）

```bash
cd baby-workbench-cloud
PORT=3000 OWNER_TOKEN=你的强口令 node server.js
# 浏览器打开 http://localhost:3000
```

- **管理员设备**：打开链接 → 右上角「☁️」→「设置」→「云端账号」→ 输入与服务器一致的 `OWNER_TOKEN` 绑定。
- **家人查看**：把 `http://localhost:3000/?view=1` 发给他们（公网部署后换成你的域名）。

> 零依赖：仅需 Node.js（>=16），无需 `npm install`。

---

## 二、一键部署到 Render（永久公网链接 · 免费）

1. 把 `baby-workbench-cloud/` 整个目录推送到你的 GitHub 仓库。
2. 打开 [render.com](https://render.com) → **New → Web Service** → 关联该仓库。
3. Render 会自动读取 `render.yaml` 并创建服务；首次部署会**随机生成 `OWNER_TOKEN`**（在 Dashboard → Environment 中可查看/修改）。
4. 部署完成后得到永久 HTTPS 链接，例如 `https://baby-workbench-cloud.onrender.com`。
5. 在自己常用设备上打开该链接 →「设置 → 云端账号」→ 输入 Render 里的 `OWNER_TOKEN` 绑定 → 即可实时同步。
6. 在**第二台设备 / Safari 桌面 PWA** 上打开同一链接、绑定**同一口令**，即自动成为同一云端账号，多端实时一致。
7. 家人发 `<你的域名>/?view=1` 即可只读实时查看最新台账。

> 备选平台：Railway / Fly.io / 任意支持 `node server.js` 的 Node 主机，设置环境变量 `PORT` 与 `OWNER_TOKEN` 即可。

---

## 三、项目结构

```
baby-workbench-cloud/
├── server.js              # 零依赖 Node 后端（REST + SSE + 文件存储 + 口令防篡改）
├── package.json
├── render.yaml            # 一键部署配置
├── data/store.json        # 云端权威数据（自动生成）
└── public/
    ├── index.html         # 前端（含云端同步层 + 只读 UI + PWA 注册）
    ├── manifest.webmanifest
    ├── sw.js              # Service Worker（PWA / 离线缓存）
    └── icon-192.png / icon-512.png
```

## 四、接口说明

| 接口 | 方法 | 权限 | 说明 |
|------|------|------|------|
| `/api/status` | GET | 公开 | `{version, updatedAt, hasData}` |
| `/api/data` | GET | 公开(只读) | 家人查看用 |
| `/api/stream` | GET(SSE) | 公开(只读) | 实时推送数据变更 |
| `/api/sync` | POST | 需 `OWNER_TOKEN` | 写云端（实时上传） |
| `/api/reset` | POST | 需 `OWNER_TOKEN` | 清空云端 |

## 五、安全说明

- 云端数据以单文件 `data/store.json` 存储；**只有持有 `OWNER_TOKEN` 的设备可写**。
- 家人只读链接（`?view=1`）不持有令牌，服务器会拒绝其任何写请求，**原始数据无法被篡改**。
- 建议 `OWNER_TOKEN` 使用足够长的随机串；部署后及时在平台后台查看并记录。
