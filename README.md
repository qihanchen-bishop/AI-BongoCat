# AI BongoCat

AI BongoCat 是一个带有 AI 对话、长期记忆和主动心跳机制的桌面猫猫。它基于 [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat) 二次开发，保留了原项目的 Live2D 桌宠、键盘/鼠标动作同步、Tauri 跨平台桌面能力，并在此基础上加入了更像“桌面伙伴”的 AI 交互能力。

当前主要面向 Ubuntu/Linux 桌面环境开发和测试。

## 演示

<video src="./demo.mp4" controls width="720"></video>

## 新增功能

- 底部聊天输入框：可以直接和桌面猫猫聊天。
- Groq 对话：通过 Groq Chat Completions API 生成猫猫回复，并支持模型自动 fallback。
- 人格配置：在 `src/assets/pet/persona.json` 中配置猫猫性格、称呼、回复规则和记忆规则。
- 长期记忆：对话后会解析模型输出，把重要信息保存到本地记忆文件，后续对话会自动带上这些记忆。
- 心跳机制：默认每 5 分钟触发一次后台心跳，让猫猫根据记忆、任务和键盘鼠标活动主动说话。
- 定时任务维护：心跳会读取本地任务，模型可以返回任务更新，本地代码会维护任务文件。
- 键盘鼠标活动感知：记录两次心跳之间的键盘按下、鼠标点击、鼠标移动情况，作为心跳输入。
- 气泡回复：猫猫的回复显示在顶部气泡中，输入框独立放在底部。

## 技术栈

- Vue 3
- Tauri 2
- Pinia
- Vite
- easy-live2d
- Groq Chat Completions API

## 安装与运行

以下流程以 Ubuntu 为主。

### 1. 安装基础依赖

安装 Node.js、pnpm、Rust 和 Tauri 在 Linux 下需要的系统依赖。

```bash
sudo apt update
sudo apt install -y \
  build-essential \
  curl \
  wget \
  file \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

安装 pnpm：

```bash
corepack enable
corepack prepare pnpm@latest --activate
```

安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

### 2. 安装项目依赖

```bash
pnpm install
```

### 3. 配置 Groq API Key

复制环境变量模板：

```bash
cp .env.example .env.local
```

编辑 `.env.local`：

```env
VITE_GROQ_API_KEY=你的_Groq_API_Key
VITE_GROQ_MODELS=llama-3.3-70b-versatile,llama-3.1-8b-instant
```

`.env.local` 会被 git 忽略，不要把真实 API Key 提交到仓库。

`VITE_GROQ_MODELS` 是模型 fallback 顺序。当前一个模型达到限额、不可用或临时失败时，会自动尝试下一个模型。

### 4. 启动开发版本

```bash
pnpm tauri dev
```

如果修改了 `.env.local`，需要完全重启开发服务，Vite 才会重新读取环境变量。

### 5. 构建

```bash
pnpm build
pnpm tauri build
```

## 配置说明

### 猫猫人格

文件位置：

```text
src/assets/pet/persona.json
```

可以配置：

- `name`：猫猫名字
- `userAddress`：猫猫对你的称呼
- `personality`：猫猫性格
- `replyRules`：回复规则
- `memoryRules`：记忆规则

### 心跳配置

文件位置：

```text
src/assets/pet/heartbeat.json
```

默认配置：

```json
{
  "intervalSeconds": 300
}
```

`intervalSeconds` 控制心跳触发间隔，默认 300 秒。每次心跳会读取长期记忆、定时任务，以及两次心跳之间的键盘鼠标活动统计，并要求猫猫给出一句简短回复。

### 初始定时任务

文件位置：

```text
src/assets/pet/scheduledTasks.json
```

这里定义默认任务模板。首次运行后，任务会写入本地 app data 目录，之后由本地任务文件和模型返回的 `task_updates` 共同维护。

### 本地记忆和任务文件

运行时数据会保存到 Tauri 的 app data 目录中：

```text
pet-memory/memory.json
pet-memory/tasks.json
pet-memory/debug.log
```

这些文件用于保存长期记忆、定时任务和调试日志，不会放在源码目录里。

如果你要维护自己的本地配置文件，建议使用 `*.local.json` 命名，避免同步到远程仓库。

## AI 输出格式

Groq 模型会被要求输出结构化 JSON：

```json
{
  "reply": "显示给用户的简短回复",
  "memory_updates": [
    {
      "id": "user_preference",
      "content": "用户喜欢安静一点的提醒方式"
    }
  ],
  "task_updates": [
    {
      "action": "upsert",
      "id": "drink_water",
      "title": "喝水提醒",
      "content": "偶尔提醒用户喝水，但不要太频繁。",
      "enabled": true
    }
  ]
}
```

本地代码只会把 `reply` 显示到气泡里，并把 `memory_updates`、`task_updates` 分别写入本地文件。

## 与原项目的关系

AI BongoCat 基于 [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat) 修改而来。原项目提供了跨平台桌宠、Live2D 模型加载、输入设备动作同步、设置面板等基础能力。本项目在这些能力上继续增加 AI 对话、记忆、心跳和定时任务维护。

如需了解原始项目，请访问：

https://github.com/ayangweb/BongoCat

## 隐私提醒

启用 AI 聊天后，你输入的内容以及被整理进提示词的长期记忆会发送给 Groq API。请不要输入密码、私钥、API Key 或其他敏感信息。

心跳机制还会把两次心跳之间的键盘鼠标活动统计发送给 Groq API，例如键盘按下次数、鼠标点击次数和鼠标移动距离估计。统计只包含数量和时间，不包含具体按键内容。
