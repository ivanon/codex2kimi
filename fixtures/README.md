# fixtures

录制回放样本，供离线回归。

- `anthropic/{text,tools,image,stream}/`：Kimi 上游返回的 Anthropic 响应/SSE。
- `responses/`：Codex 真实发出的 Responses 请求（验证请求翻译方向）。

## 脱敏规则（提交前必做）

- 删除/替换 `x-api-key`、`authorization`。
- 替换用户内容中的真实敏感数据为占位。
- 文件名用场景描述，不含密钥或个人信息。
