# Raspberry Pi Z-Wave Test Platform

本项目严格按照 `ARCHITECTURE.md` 落地：

- 运行环境固定为树莓派 Ubuntu
- 结构固定为 `frontend/` + `backend/`
- Z-Wave Runtime 固定为后端直连 `zwave-js`
- 所有测试规则固定在后端执行
- 数据固定写入本地 SQLite 与本地日志目录

## 当前交付内容

- 前端 Vue 3 + Vite + Pinia 首版页面骨架
- 后端 Fastify + WebSocket + SQLite 首版服务骨架
- `zwave-js` 直连适配器抽象与首版事件编排
- 带状态轮询断言的门锁 / 二进制开关 / 节点健康测试定义
- 登录会话、静态 Token、WebSocket 鉴权预留
- systemd 与 Ubuntu 部署脚本模板

## 开发与验收原则

根据架构文档，功能联调、依赖安装验证、Controller 连接验证、设备入网验证、测试执行验证必须在树莓派 Ubuntu 上完成；当前仓库仅提供代码落地，不把 macOS 作为运行验收环境。

## 推荐部署路径

- 应用目录：`/opt/zwave-test-platform`
- 数据目录：`/var/lib/zwave-test-platform`
- 日志目录：`/var/log/zwave-test-platform`

## 目录说明

- `frontend/`：Web UI
- `backend/`：Fastify 服务、Z-Wave 运行时与测试引擎
- `data/`：本地开发/示例数据目录
- `deploy/`：systemd 与 Ubuntu 脚本

## 树莓派 Ubuntu 上的建议步骤

1. 执行 `deploy/scripts/prepare-ubuntu.sh`
2. 执行 `deploy/scripts/bootstrap-env.sh`
3. 编辑 `backend/.env`
4. 如需密码登录，执行 `node backend/scripts/generate-password-hash.mjs '<password>'`
5. 构建前后端：`npm run build`
6. 启动后端：`npm --workspace backend run start`
7. 接入 systemd：使用 `deploy/systemd/zwave-test-platform.service` 或 `deploy/scripts/install.sh`

## 配置补充

- `ZWAVE_KEY_*`：S2 / S0 安全入网所需的 16-byte hex key
- `API_TOKEN`：可选；配置后可直接作为静态运维 Token 使用
- `ADMIN_USERNAME` + `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH`：启用正式登录会话
- `AUTH_SESSION_TTL_HOURS`：浏览器登录会话有效期
- 前端浏览器可在 `Login` 页面登录，也可在 `System` 页面保存 token 到本地 `localStorage`

## 部署脚本

- `deploy/scripts/one-click-deploy-rpi.sh`：树莓派 Ubuntu 一键部署；默认登录密码 `123456`
- `deploy/scripts/restart-platform.sh`：重启平台；会先检查端口占用，发现占用后执行 `kill -9`
- `deploy/scripts/tail-logs.sh`：实时查看后端服务日志，支持 `backend` / `controller` / `zwave` / `errors` / `all`
- `deploy/scripts/prepare-ubuntu.sh`：安装 Ubuntu 依赖与 Node.js LTS
- `deploy/scripts/bootstrap-env.sh`：从样例生成 `backend/.env`
- `deploy/scripts/install.sh`：同步代码、安装依赖、构建并注册 systemd
- `backend/scripts/generate-password-hash.mjs`：生成 `ADMIN_PASSWORD_HASH`

## 重启脚本

- 首次安装用：`bash deploy/scripts/one-click-deploy-rpi.sh`
- 日常重启用：`bash deploy/scripts/restart-platform.sh`
- 脚本会先检查后端端口和前端端口是否被占用；若被占用会执行 `kill -9`
- 默认后端端口读取 `backend/.env` 里的 `PORT`，默认前端端口为 `5173`
- 如有单独前端 systemd 服务，可额外传入：`FRONTEND_SERVICE_NAME=<your-frontend.service> bash deploy/scripts/restart-platform.sh`

## 日志查看

- 实时查看后端完整运行日志：`bash deploy/scripts/tail-logs.sh`
- 只看 Controller 连接相关日志：`bash deploy/scripts/tail-logs.sh controller`
- 实时查看筛选后的 Z-Wave 相关日志：`bash deploy/scripts/tail-logs.sh zwave`
- 仅查看错误相关日志：`bash deploy/scripts/tail-logs.sh errors`
- 实时查看全部服务日志：`bash deploy/scripts/tail-logs.sh all`
- 如当前用户没有 journal 权限，脚本会自动尝试走 `sudo journalctl`
