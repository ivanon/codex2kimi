# codex2kimi

本地 HTTP 代理：把 Codex 的 OpenAI Responses API 请求转换为 Anthropic Messages 格式，转发给 Kimi code 端点（伪装成 Claude Code），并把回复转换回 Responses 格式。支持 SSE 流式、工具调用、多模态图片。

设计文档见 `docs/superpowers/specs/2026-06-10-codex2kimi-design.md`，实现计划见 `docs/superpowers/plans/2026-06-10-codex2kimi.md`。

## 要求

- Node.js ≥ 20.11（依赖内置 `fetch` 与 `import.meta.dirname`）
- macOS（LaunchAgent 部署）

## 配置

创建 `~/.config/codex2kimi/config.json`（权限 600，避免泄露 key）：

```json
{
  "anthropicApiKey": "你的 Kimi API Key",
  "model": "claude-sonnet-4-5-20250929"
}
```

```bash
chmod 600 ~/.config/codex2kimi/config.json
```

可选键：`port`（默认 8787）、`anthropicBaseUrl`（默认 `https://api.kimi.com/coding/`）、`maxTokensDefault`、`userAgent`、`logLevel`。环境变量可覆盖：`CODEX2KIMI_API_KEY`、`CODEX2KIMI_PORT`、`CODEX2KIMI_BASE_URL`、`CODEX2KIMI_MODEL`、`CODEX2KIMI_LOG_LEVEL`。

> 安全：服务仅绑定 `127.0.0.1`，请勿反代暴露到公网（否则等于公开你的 API Key）。

## 开发

```bash
npm install
npm run dev        # tsx watch
npm test           # 单元/回放测试
npm run typecheck
```

## 作为系统服务安装（LaunchAgent）

```bash
./deploy/install.sh
```

管理命令：

```bash
launchctl print gui/$UID/com.codex2kimi.proxy        # 查状态
launchctl kickstart -k gui/$UID/com.codex2kimi.proxy # 重启（改配置后生效）
./deploy/uninstall.sh                                # 卸载
```

日志：`~/Library/Logs/codex2kimi.log`（无自动轮转，按需手动清理或配置 `newsyslog`）。

## 接入 Codex

把 Codex 的 provider base URL 指向 `http://127.0.0.1:8787`。联调步骤见 `docs/superpowers/runbook-codex2kimi.md`。
