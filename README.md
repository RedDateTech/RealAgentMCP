# realagent-mcp

国信智能体实名关联服务 MCP Server — 单个可执行文件 · 本地通信 · 国密加密 · 全平台支持。

为 AI Agent 提供 SM2 实名身份关联、SD-JWT 可验证证明（VP）生成与验证、SM2 密码学操作等能力。

## 安装

```bash
npm i -g realagent-mcp
```

> 必须全局安装（`-g`）。这样 `realagent-mcp` 会进入 PATH，MCP 配置里的
> `npx realagent-mcp` 才会命中全局副本，而不会每次都往 `_npx` 缓存里再拉一份
> （即避免依赖重复与 npx 旧缓存问题）。

配置 MCP Client（`--agent-id` 必填，每个 Agent 使用唯一名称）：

```json
{
  "mcpServers": {
    "realagent-mcp": {
      "command": "npx",
      "args": ["-y", "realagent-mcp", "stdio", "--agent-id", "my-agent"]
    }
  }
}
```

## 升级

```bash
npm update -g realagent-mcp
# 或
npm i -g realagent-mcp@latest
```

升级后重启 MCP Client 即可。Agent 会在每次对话开始时自动调用 `system_update` 检查新版本。

## 功能

- **SM2 密钥对生成** — 国密 SM2 签名/验签/加解密
- **实名关联** — 生成二维码 → 扫码认证 → 自动领取 VC
- **VP 生成/验证** — SD-JWT 可验证证明，W3C VC Data Model v2
- **SM4 加密存储** — 私钥和 VC 使用 SM4-CTR+SM3-HMAC 本地加密
- **自动更新** — 内置版本检查 + system_update 工具

## AGENT INSTRUCTIONS

> 以下内容供 AI Agent 读取，用于自动完成安装和配置。

1. **Prerequisite — verify Node.js (do this FIRST, before installing).**
   realagent-mcp requires Node.js >= 18.13 (npm and npx are bundled with it).
   Before installing, check the environment:

   - Run `node --version` and `npm --version`. If both succeed **and**
     `node --version` reports >= v18.13, skip to step 2.
   - If `node`/`npm` is not found (no Node.js) or the version is older than
     18.13, **stop and help the user set it up before going further**:
     - **Windows**: `winget install OpenJS.NodeJS.LTS` (PowerShell), or
       download the LTS installer from https://nodejs.org.
     - **macOS**: `brew install node@22`, or `nvm install --lts` (nvm:
       https://github.com/nvm-sh/nvm).
     - **Linux**: `nvm install --lts` (nvm:
       https://github.com/nvm-sh/nvm), or the NodeSource repo for your
       distro.
   - After installing/upgrading, have the user **restart the terminal and
     MCP client**, then re-verify with `node --version`, `npm --version`,
     and `npx --version`. Only proceed to step 2 once all three succeed and
     Node >= 18.13 is confirmed.

2. Install via npm (global, so `realagent-mcp` is on PATH):
   ```
   npm i -g realagent-mcp
   ```
3. MCP client config — Each agent MUST have a unique `--agent-id`.
   One agent-id = one identity = one SM2 key pair. Never reuse an agent-id
   across agents. The realagent platform registers each key pair as a
   separate identity; shared agent-id causes identity conflicts.

   Generate an agent-id yourself, using a descriptive name based on the
   current project or the agent's purpose (e.g. "my-claude-code",
   "frontend-dev-helper", "pr-review-bot"). Use lowercase letters, digits
   and hyphens only. Then ASK the user to confirm before using it:

   > I'll configure realagent-mcp with agent-id: \<name\>. This name will be
   > used to derive your unique SM2 identity. Is that OK? You can change
   > it to any name you prefer.

   Once confirmed, write this MCP config:

   ```json
   {
     "mcpServers": {
       "realagent-mcp": {
         "command": "npx",
         "args": [
           "-y",
           "realagent-mcp",
           "stdio",
           "--agent-id",
           "<confirmed-name>"
         ]
       }
     }
   }
   ```

   Data is stored under `.realagent/agents/` in the working directory.
   Add `--data-dir` to customize the path.

4. Restart the MCP client. The server exposes 14 tools (5 identity + 4 key/VC
   + 4 crypto + 1 system). Start with `identity_status`.
5. Version check — Call `system_update` at the start of each conversation
   (or at least once per day). When an update is available, tell the user and
   help them run `npm update -g realagent-mcp` or `npm i -g realagent-mcp@latest`. Only
   skip the version check if the user explicitly asks you to.
