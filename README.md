# Telegram Codex Remote Control

`telegram-codex-remote-control` 是一个基于 Node.js 和 TypeScript 的 Telegram 机器人服务，用来把 Codex 会话暴露到 Telegram 私聊里。你可以直接在 Telegram 中发送文本、图片或文件，让 Codex 在指定工作目录中执行任务，并把生成的图片或文件自动回传到聊天窗口。

这个项目适合下面几类场景：

- 在手机上远程查看和修改代码
- 远程运行 Codex 做文档整理、排查、代码生成或文件处理
- 把 Telegram 当作一个轻量的 Codex 控制面板

## 项目能做什么

- 只允许指定的 Telegram 用户在私聊中访问
- 支持直接发送文本任务给 Codex
- 支持发送图片和文件，附带说明作为提示词
- 自动把附件下载到临时目录，再交给 Codex 使用
- 自动监听当前工作目录下的 `.relay-out`，把新增或更新的文件回传到 Telegram
- 保存 Codex 线程 ID 和当前工作目录，支持重启后继续已有会话
- 保存最近 10 条历史会话，可在 Telegram 中通过按钮切换或删除
- 提供 `/status`、`/pwd`、`/cd`、`/model`、`/stop`、`/new`、`/sessions` 等控制命令

## 工作方式

服务启动后会做三件事：

1. 启动 Telegram Bot 轮询。
2. 接收来自白名单用户的私聊消息、图片和文件。
3. 把消息转成 Codex 输入，并在当前工作目录中启动或恢复一个 Codex 线程。

每次任务执行时，服务会：

- 把 Telegram 附件保存到 `data/tmp/<run-id>/input`
- 把当前工作目录下的 `.relay-out` 作为回传目录
- 将“如果你需要把图片或文件回传到 Telegram，请将副本放到：`<exportDir>`”追加到提示中
- 实时把 Codex 输出、状态和命令执行摘要同步回 Telegram
- 在任务结束后扫描 `.relay-out`，把新生成或被更新的文件发回聊天窗口

## 项目结构

```text
.
├─ config/
│  ├─ relay.config.example.json
│  └─ relay.config.docker.example.json
├─ docker/
│  ├─ .env.example
│  ├─ Dockerfile
│  ├─ docker-compose.example.yml
│  └─ entrypoint.sh
├─ scripts/
│  ├─ bootstrap.sh
│  ├─ deploy.sh
│  ├─ lib.sh
│  └─ build-native.mjs
├─ src/
│  ├─ index.ts
│  ├─ service.ts
│  ├─ telegram.ts
│  ├─ codex.ts
│  ├─ attachments.ts
│  ├─ state.ts
│  ├─ config.ts
│  ├─ renderer.ts
│  └─ types.ts
├─ .env.example
├─ package.json
└─ tsconfig.json
```

## 环境要求

- Node.js 20 或更高版本
- npm
- 一个可用的 Telegram Bot Token
- 一个允许调用 Codex 的 OpenAI API Key 或兼容代理 Key

如果你使用 Docker，则本地只需要：

- Docker
- Docker Compose

## 配置

项目配置分成两部分：

- `.env`：敏感信息和身份信息
- `config/relay.config.json`：运行目录、模型、沙箱和网络策略

### 1. 环境变量

原生运行时，从根目录 `.env.example` 复制为 `.env`：

```bash
cp .env.example .env
```

Windows PowerShell 可用：

```powershell
Copy-Item .env.example .env
```

示例：

```env
TELEGRAM_BOT_TOKEN=123456:telegram-token
ALLOWED_TELEGRAM_USER_ID=123456789
OPENAI_API_KEY=sk-...
```

字段说明：

- `TELEGRAM_BOT_TOKEN`：Telegram 机器人令牌
- `ALLOWED_TELEGRAM_USER_ID`：允许访问机器人的 Telegram 数字用户 ID，只允许该用户私聊使用
- `OPENAI_API_KEY`：传给 Codex SDK 的 API Key

### 2. 运行配置

把 `config/relay.config.example.json` 复制为 `config/relay.config.json`：

```bash
cp config/relay.config.example.json config/relay.config.json
```

Windows PowerShell 可用：

```powershell
Copy-Item config/relay.config.example.json config/relay.config.json
```

示例：

```json
{
  "defaultCwd": "D:/LD",
  "dataDir": "./data",
  "tempDir": "./data/tmp",
  "stateFile": "./data/state.json",
  "codexHome": "./data/codex-home",
  "telegram": {
    "pollTimeoutSeconds": 10
  },
  "codex": {
    "baseUrl": "https://api.openai.com/v1",
    "provider": {
      "id": "relay_proxy",
      "name": "Relay Proxy",
      "envKey": "OPENAI_API_KEY",
      "wireApi": "responses",
      "supportsWebsockets": false
    },
    "model": "gpt-5.4",
    "models": ["gpt-5.4", "gpt-5.4-mini"],
    "reasoningEffort": "medium",
    "approvalPolicy": "never",
    "sandboxMode": "danger-full-access",
    "skipGitRepoCheck": true,
    "networkAccessEnabled": true
  }
}
```

主要字段说明：

- `defaultCwd`：默认工作目录。支持绝对路径，也支持相对 `appRoot` 的路径
- `dataDir`：运行时数据目录
- `tempDir`：附件暂存目录
- `stateFile`：服务状态文件，保存当前目录、线程 ID、当前会话模型和历史会话
- `codexHome`：传给 Codex 进程的 `CODEX_HOME`
- `telegram.pollTimeoutSeconds`：Telegram 长轮询超时
- `codex.baseUrl`：可选，自定义 OpenAI 兼容接口地址；不填时使用官方默认地址
- `codex.provider`：可选，只有在配置了 `baseUrl` 时才有意义，用于声明自定义 provider
- `codex.model`：默认模型名；新会话会先回到这个默认值
- `codex.models`：可选模型列表。服务启动后先使用 `codex.model` 作为当前会话默认值，你可以随时在 Telegram 中通过 `/model` 切换当前会话模型，并继续沿用当前会话上下文
- `codex.reasoningEffort`：推理强度，可选值为 `minimal`、`low`、`medium`、`high`、`xhigh`
- `codex.approvalPolicy`：审批策略
- `codex.sandboxMode`：沙箱模式
- `codex.skipGitRepoCheck`：是否跳过 Git 仓库检查
- `codex.networkAccessEnabled`：是否允许网络访问

## 本地开发与运行

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

这会直接用 `tsx` 运行 `src/index.ts`。

### 构建

```bash
npm run build
```

构建产物输出到 `dist/`。

### 生产运行

```bash
npm start
```

## Docker 部署

### Ubuntu 一键脚本

如果服务器是 Ubuntu 且源码已经在服务器上，优先用下面两个脚本：

- `scripts/bootstrap.sh`：首次初始化，安装 Docker、生成 Docker 配置并直接拉起服务
- `scripts/deploy.sh`：后续更新部署，读取现有配置并重建或重启容器

两个脚本都为非交互式，参数通过环境变量传入。

需要区分两类配置：

- `docker/.env`：容器创建级配置，主要是令牌、用户 ID、API Key、宿主机工作目录挂载路径
- `docker/config/relay.config.json`：运行级配置，主要是模型、推理强度、沙箱、网络、默认工作目录

这两类配置的生效方式不同：

- 修改 `docker/.env` 后，通常需要执行 `bash scripts/deploy.sh` 让 Compose 重新创建 `relay` 容器；单纯 `restart` 不会更新容器环境变量
- 修改 `docker/config/relay.config.json` 后，不需要删除容器，也不需要重建镜像；执行 `RESTART_ONLY=1 bash scripts/deploy.sh` 重启服务即可

#### 首次初始化

```bash
cd /opt/telegram-codex-remote-control

TELEGRAM_BOT_TOKEN=... \
ALLOWED_TELEGRAM_USER_ID=... \
OPENAI_API_KEY=... \
WORKSPACE_HOST_PATH=/srv/codex/workspace \
MODEL=gpt-5.4 \
REASONING_EFFORT=xhigh \
bash scripts/bootstrap.sh
```

可选环境变量：

- `FORCE=1`：覆盖已有 `docker/.env` 和 `docker/config/relay.config.json`
- `BASE_URL=https://api.openai.com/v1`：首次生成 `docker/config/relay.config.json` 时写入自定义兼容接口地址
- `APPROVAL_POLICY=never`：首次生成运行配置时写入
- `SANDBOX_MODE=danger-full-access`：首次生成运行配置时写入
- `SKIP_GIT_REPO_CHECK=true`：首次生成运行配置时写入
- `NETWORK_ACCESS_ENABLED=true`：首次生成运行配置时写入
- `POLL_TIMEOUT_SECONDS=10`：首次生成运行配置时写入

可选 GitHub 集成变量：

- `GITHUB_ENABLE=true`：启用容器启动时的 GitHub 初始化
- `GITHUB_USERNAME=codex-bot`：写入容器内 Git 提交身份名称
- `GITHUB_EMAIL=bot@example.com`：写入容器内 Git 提交身份邮箱
- `GITHUB_TOKEN_FILE=/run/secrets/github_token`：容器内 GitHub PAT 文件路径

如果要启用 GitHub 集成，还需要在宿主机 `docker/secrets/` 下准备只读 token 文件：

```bash
mkdir -p docker/secrets
chmod 700 docker/secrets
printf '%s\n' "${GITHUB_PAT:?set GITHUB_PAT first}" > docker/secrets/github_token
chmod 600 docker/secrets/github_token
```

上面的示例使用 POSIX shell；如果你在 Windows 上手动准备该文件，请改用等价命令或在 WSL、Git Bash 等 POSIX 环境中执行。
创建或轮换 `github_token` 后，需要在下一次容器或服务重启时才会生效，不会热加载。

不需要 GitHub 时，保持 `GITHUB_ENABLE=false` 即可。容器会继续正常启动，并在日志中输出 `GitHub integration disabled`。

该 PAT 需要具备足够的权限或 scopes，至少要能创建仓库、克隆私有仓库并向目标仓库推送代码。

启用后，运行中的 `relay` 服务进程及其拉起的 Codex 任务流程会在启动后获得 GitHub 认证；这不会自动作用于你后续手动打开的任意全新 `docker exec` shell。
如果你已经有现成的 `docker/docker-compose.yml`，`bootstrap.sh` 不会自动重新生成它；启用 GitHub 时除了刷新 `docker/.env` 里的相关值，还要手动同步 `./secrets:/run/secrets:ro` 挂载。

注意：

- 这里的 `MODEL`、`REASONING_EFFORT`、`BASE_URL`、`APPROVAL_POLICY`、`SANDBOX_MODE` 等变量，是给初始化脚本用来“生成 `docker/config/relay.config.json`”的，不是容器内可热更新的运行环境变量
- 如果后面要调整这些运行参数，直接编辑 `docker/config/relay.config.json`，然后执行 `RESTART_ONLY=1 bash scripts/deploy.sh` 即可

首次执行后会自动生成：

- `docker/docker-compose.yml`
- `docker/.env`
- `docker/config/relay.config.json`
- `docker/data/`
- `docker/secrets/`

#### 后续更新部署

```bash
cd /opt/telegram-codex-remote-control
bash scripts/deploy.sh
```

可选环境变量：

- `PULL=1`：重建前先拉基础镜像
- `FORCE_REBUILD=1`：无缓存重建镜像
- `RESTART_ONLY=1`：只重启服务，不重建

#### Skills 和持久化目录

Docker 模式下，容器内 `/app/data` 会映射到宿主机：

```text
<项目目录>/docker/data
```

如果你手动安装 skills，直接放到：

```text
<项目目录>/docker/data/codex-home/skills
```

放完之后执行：

```bash
cd /opt/telegram-codex-remote-control
RESTART_ONLY=1 bash scripts/deploy.sh
```

### 构建镜像

```bash
npm run package:docker
```

或直接：

```bash
docker build -f docker/Dockerfile -t telegram-codex-remote-control:local .
```

### 使用 docker-compose

1. 在仓库根目录执行 `cd docker/`。下面这个小节中的相对路径（例如 `.env`、`config/relay.config.json`、`secrets/github_token`）都以当前 `docker/` 目录为准。
2. 将 `docker-compose.example.yml` 复制为你自己的 `docker-compose.yml`。
3. 将 `.env.example` 复制为 `.env`：

```bash
cp .env.example .env
```

Windows PowerShell 可用：

```powershell
Copy-Item .env.example .env
```

最小示例：

```env
TELEGRAM_BOT_TOKEN=...
ALLOWED_TELEGRAM_USER_ID=...
OPENAI_API_KEY=...
WORKSPACE_HOST_PATH=D:/LD
```

说明：

- 当前目录下的 `.env`（仓库根目录对应 `docker/.env`）适合放少量不常改、且本来就依赖容器创建的参数
- 如果你修改了当前目录下的 `.env`，需要执行 `bash ../scripts/deploy.sh` 或从仓库根目录执行 `bash scripts/deploy.sh`，让容器按新环境重新创建
- 如果你只是想改模型、推理强度、沙箱或网络策略，不要改这里，去改当前目录下的 `config/relay.config.json`

可选 GitHub 集成示例：

```env
GITHUB_ENABLE=true
GITHUB_USERNAME=codex-bot
GITHUB_EMAIL=bot@example.com
GITHUB_TOKEN_FILE=/run/secrets/github_token
```

如果启用了这组变量，还需要在当前 `docker/` 目录下的 `secrets/` 中准备对应的只读 token 文件：

```bash
mkdir -p secrets
chmod 700 secrets
printf '%s\n' "${GITHUB_PAT:?set GITHUB_PAT first}" > secrets/github_token
chmod 600 secrets/github_token
```

上面的示例使用 POSIX shell；如果你在 Windows 上手动准备该文件，请改用等价命令或在 WSL、Git Bash 等 POSIX 环境中执行。
创建或轮换 `github_token` 后，需要在下一次容器或服务重启时才会生效，不会热加载。

该 PAT 需要具备足够的权限或 scopes，至少要能创建仓库、克隆私有仓库并向目标仓库推送代码。

如果不需要 GitHub，保持 `GITHUB_ENABLE=false` 即可。容器仍会正常启动，并在日志中输出 `GitHub integration disabled`。

启用后，运行中的 `relay` 服务进程及其拉起的 Codex 任务流程会在启动后获得 GitHub 认证，因此在这条任务链路里可以执行 `gh repo create`、`gh repo clone`、`git pull` 和 `git push`。

默认 Compose 示例现在会把 `./secrets:/run/secrets:ro` 作为只读挂载提供给容器。

如果你已经存在旧的 `docker/docker-compose.yml` 和 `docker/.env`，启用 GitHub 时需要手动同步两处：把新的 GitHub 环境变量写入 `.env`，并把 `./secrets:/run/secrets:ro` 挂载补到 `docker-compose.yml`。

4. 准备当前目录下的 `config/relay.config.json`，可参考仓库根目录的 `config/relay.config.docker.example.json`。
5. 启动：

```bash
docker compose up -d --build
```

默认挂载关系：

- `./config -> /app/config`
- `./data -> /app/data`
- `./secrets -> /run/secrets`（只读，对应 Compose 中的 `./secrets:/run/secrets:ro`）
- `${WORKSPACE_HOST_PATH} -> /workspace`

Docker 示例配置中，`defaultCwd` 默认应设置为 `/workspace`。

如果后续只修改了 `docker/config/relay.config.json`，直接执行：

```bash
cd /opt/telegram-codex-remote-control
RESTART_ONLY=1 bash scripts/deploy.sh
```

这会重启服务进程并重新读取配置文件，不需要删除容器。

## 原生打包

项目支持生成带 Codex 运行时 sidecar 的原生发布目录。

### 仅生成打包前 bundle

```bash
npm run bundle:sea
```

### 生成原生发布包

```bash
npm run package:native
```

输出目录为：

```text
release/<platform>/
```

其中通常会包含：

- 可执行文件
- `app.mjs`
- `runtime/codex/`
- `config/relay.config.example.json`
- `.env.example`

说明：

- 这里不是单一二进制分发，而是“可执行文件 + JS bundle + Codex runtime”的发布目录
- 打包脚本依赖 `@openai/codex-sdk` 拉下来的平台 sidecar

## Telegram 使用说明

### 直接发送文本

直接给机器人发一段文本，服务会把这段文本作为 Codex 任务输入。

示例：

```text
帮我查看当前目录下有哪些 Node 项目，并整理成表格
```

### 发送图片或文件

- 图片消息：会作为图片附件传给 Codex
- 文档消息：会保存为本地文件后传给 Codex
- Caption：会作为该次任务的文本提示

如果没有填写 Caption：

- 图片默认提示为 `请分析这张图片。`
- 文件默认提示为 `请检查这个文件。`

### 可用命令

- `/status`：查看当前状态、工作目录、线程状态、模型和沙箱配置
- `/pwd`：查看当前工作目录
- `/cd <path>`：切换工作目录，并重置当前 Codex 线程和当前会话模型
- `/model`：显示模型按钮列表，切换当前会话模型，并继续沿用当前会话上下文
- `/stop`：中止当前正在运行的任务
- `/new`：清空当前线程，下一个任务会创建新会话并恢复默认模型
- `/sessions`：显示最近 10 条历史会话；正文显示详细信息，按钮只保留编号，左侧切换，右侧删除

`/sessions` 补充说明：

- 正文里会显示“编号 + 最近使用时间 + 目录名 + 模型 + 文本摘要”
- 按钮只显示编号，避免 Telegram 客户端把长按钮文本截断
- 删除的是本地保存的历史会话记录；删除当前会话后，下一个任务会新建会话

### 产物回传规则

服务不会自动抓取任意路径下的文件，只会扫描当前工作目录的 `.relay-out`。

如果希望让生成的图片或文件自动回到 Telegram，需要让 Codex 把文件复制到：

```text
<当前工作目录>/.relay-out
```

服务只会发送该目录中“本次任务新增或被修改”的文件。

## 状态与恢复

服务会把状态保存到 `stateFile` 指定的位置，主要包括：

- 当前工作目录
- 当前 Codex 线程 ID
- 恢复状态
- 是否有未正常结束的任务

服务重启后会尝试恢复线程。如果保存的线程不存在，则会自动回退为新线程继续工作。

## 故障排查

### 启动时报配置错误

优先检查：

- `.env` 是否存在
- `config/relay.config.json` 是否存在
- `defaultCwd` 指向的目录是否真实存在
- `baseUrl` 是否为合法的绝对 URL
- `provider` 是否与 `baseUrl` 一起配置

### 启动失败日志

启动阶段的致命错误会写入：

```text
startup-error.log
```

该文件位于应用根目录。

### 机器人没有响应

检查下面几项：

- 你是不是在私聊里使用机器人
- 发送消息的用户 ID 是否等于 `ALLOWED_TELEGRAM_USER_ID`
- `TELEGRAM_BOT_TOKEN` 是否正确
- 当前是否已有任务在运行中

## 安全注意事项

- 当前示例配置使用的是 `danger-full-access`
- 当前示例配置启用了网络访问
- 当前示例配置允许 Codex 在目标工作目录内进行真实读写

如果你要把它部署到长期运行环境，建议至少重新评估：

- `sandboxMode`
- `approvalPolicy`
- `networkAccessEnabled`
- `defaultCwd` 的权限边界

## 许可证

本项目采用 [MIT License](./LICENSE) 开源。
