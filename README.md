# dsh-tmp-cleaner

**[中文](README.md) | [English](README.en.md)**

DSH 插件：保证 `/tmp` 清理守护进程一直活着，并在「设置」里提供一个「临时清理」页。

- 启动时确保 `tmp-clean watch` 在跑；被 Android 杀掉后 **≤2 分钟自动复活**（进程内看门狗），
  即使守护进程一直被系统杀，到期的清理由 dsh 进程自己兜底执行；
- 设置页可看状态、改配置、立即清理 / 演练，所有请求走 `/tmp-clean/api/*`；
- 清理工具本体是零依赖 Python 3 脚本，命令行与设置页**共用同一份配置**。

## 仓库内容

| 路径 | 说明 |
|---|---|
| `lib/index.js` | 宿主半边：看门狗、`/tmp-clean/api/*` 路由 |
| `lib/client.js` | 浏览器半边：`settings.section` 里的「临时清理」页 |
| `bin/tmp-clean` | 清理工具本体（Python 3，零第三方依赖） |
| `cordis.patch.yml` | 插件行声明（`dsh.bundle`） |
| `test/*.mjs` | 离线测试（假 ctx / 假 loader） |

工具默认从 `/root/dsh-bin/tmp-clean` 调用（`lib/index.js` 的 `TOOL` 常量）；
装到别处时改这个常量，或把 `bin/tmp-clean` 复制/链接到该路径。

## 宿主半边（lib/index.js）

1. web 启动（或 HMR 重载本插件）时调用 `apply()`：
   - 若 `watch.pid` 对应的进程**确实是 tmp-clean**（核对 `/proc/<pid>/cmdline`，防 PID 复用误判）→ 不动；
     否则 detached 拉起 `tmp-clean watch`；
   - 异常只写 stderr，不影响 web 启动。
2. **进程内看门狗**（每 2 分钟）：
   - Android 的 phantom process killer 会时不时杀掉 detached 子进程。以前只有重启 web 才会重新拉起，
     表现就是设置页一直「守护进程：未运行」。现在掉线后 ≤2 分钟自动复活；
   - 重拉本身有 5 分钟冷却，避免连环刷进程；
   - 若守护进程持续缺席 ≥3 分钟，且按 `interval_hours` 已到期，则由 **dsh 进程自己**执行
     `tmp-clean run` 兜底清理。
3. 注册路由（经 `ctx.inject(['webServer'], …)`）：
   - `GET  /tmp-clean/api/status` → `tmp-clean status --json --fast` + 日志尾（默认不扫盘，页面秒开）
   - `GET  /tmp-clean/api/status?scan=1` → 完整扫描 `/tmp` 实际占用（7–20 秒，仅手动触发）
   - `POST /tmp-clean/api/revive` → 手动拉起守护进程（带冷却）
   - `POST /tmp-clean/api/config` → `tmp-clean config set …`
   - `POST /tmp-clean/api/run` → `tmp-clean run [--dry-run]`

## 浏览器半边（lib/client.js）

以 `window.__ModuleLoader__.load({ id, factory })` 手写 bundle 形式发布，
注册到 `settings.section` 槽位（id `tmp-cleaner`，order 60，标签「临时清理」）：

- 状态默认走快路径；「扫描大小」按钮才触发完整扫盘；
- 读取失败时给出原因和「重试」按钮（web 刚重启后常见，不必刷新整页）；
- 守护进程未运行时显示「看门狗 2 分钟内自动拉起」，不再是无解释的「未运行」。

## 配置

`/root/.tmp-clean/config.json`（命令行与设置页共用）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 是否启用自动清理 |
| `interval_hours` | 24 | 清理周期（小时） |
| `max_size_gb` | 20 | 超过该占用就清 |
| `target_size_gb` | 10 | 清到该占用为止 |
| `min_age_hours` | 2 | 只删这么旧的目录 |
| `poll_minutes` | 15 | 守护进程轮询间隔 |
| `dry_run` | false | 演练模式（不真删） |

## 测试

```bash
node test/host-test.mjs     # 假 ctx：4 条路由 + 快/慢状态 + revive + CLI 读写往返
node test/client-test.mjs   # 假 loader：materialize bundle + 注册/渲染断言
node test/probe-web.mjs     # 对运行中的 web 探测（需有效本地 cookie）
```

## 安装 / 卸载

- 安装：把仓库放进 `/root/dsh-tmp-cleaner`，在 profile 的 `dependencies` 加
  `"dsh-tmp-cleaner": "link:/root/dsh-tmp-cleaner"`、`dsh.profile.bundles` 加 `dsh-tmp-cleaner`，
  建 `node_modules/dsh-tmp-cleaner` 链接，把 `bin/tmp-clean` 放到 `/root/dsh-bin/`，**重启一次 web**。
- 卸载：反做上述步骤，并 `kill $(cat /root/.tmp-clean/watch.pid)`。
