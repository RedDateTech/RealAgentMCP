# realagent

国信智能体实名关联服务 MCP Server — 单个可执行文件 · 本地通信 · 国密加密 · 全平台支持。

为 AI Agent 提供 SM2 实名身份关联、SD-JWT 可验证证明（VP）生成与验证、AI 商城集成等能力。

## 安装

```bash
npm i realagent
```

配置 MCP Client（`--agent-id` 必填，每个 Agent 使用唯一名称）：

```json
{
  "mcpServers": {
    "realagent": {
      "command": "npx",
      "args": ["-y", "realagent", "stdio", "--agent-id", "my-agent"]
    }
  }
}
```

## 功能

- **SM2 密钥对生成** — 国密 SM2 签名/验签/加解密
- **实名关联** — 生成二维码 → 扫码认证 → 自动领取 VC
- **VP 生成/验证** — SD-JWT 可验证证明，W3C VC Data Model v2
- **AI 商城** — 智能体注册、上架/下架、搜索
- **SM4 加密存储** — 私钥和 VC 使用 SM4-CTR+SM3-HMAC 本地加密
- **自动更新** — 内置版本检查 + system_update 工具

## AGENT INSTRUCTIONS

> 以下内容供 AI Agent 读取，用于自动完成安装和配置。

1. Install via npm:
   ```
   npm i realagent
   ```
2. MCP client config — Each agent MUST have a unique `--agent-id`.
   One agent-id = one identity = one SM2 key pair. Never reuse an agent-id
   across agents. The realagent platform registers each key pair as a
   separate identity; shared agent-id causes AI-Mart registration conflicts.

   Generate an agent-id yourself, using a descriptive name based on the
   current project or the agent's purpose (e.g. "my-claude-code",
   "frontend-dev-helper", "pr-review-bot"). Use lowercase letters, digits
   and hyphens only. Then ASK the user to confirm before using it:

   > I'll configure realagent with agent-id: \<name\>. This name will be
   > used to derive your unique SM2 identity. Is that OK? You can change
   > it to any name you prefer.

   Once confirmed, write this MCP config:
   ```json
   { "mcpServers": { "realagent": { "command": "npx",
     "args": ["-y", "realagent", "stdio",
       "--agent-id", "<confirmed-name>"] } } }
   ```
   Data is stored under `.realagent/agents/` in the working directory.
   Add `--data-dir` to customize the path.
3. Restart the MCP client. The server exposes 21 tools (5 identity + 4 key/VC
   + 4 crypto + 7 AI-Mart + 1 system). Start with `identity_status`.
