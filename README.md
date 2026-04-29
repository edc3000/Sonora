<div align="center">

<h1>📻 Sonora AI Radio</h1>

<p>
  <em>一个本地优先的个人 AI 电台 App | A Local-First Personal AI Radio App</em>
</p>

<!-- Badges -->
<p>
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/Node.js-18.x-green.svg" alt="Node.js">
  </a>
  <a href="#api-contract">
    <img src="https://img.shields.io/badge/API-REST%20%7C%20WebSocket-orange.svg" alt="API">
  </a>
  <a href="#license">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License">
  </a>
</p>
</div>

<hr />

## ✨ 特性 (Features)

- **🎧 本地优先 (Local-First)**: 核心决策在本地完成，确保隐私与响应速度。
- **🧠 智能大脑层 (Smart Brain Layer)**: 内置路由 (`router.js`)、上下文管理 (`context.js`)、Agent (`agent.js`)、任务调度 (`scheduler.js`) 以及 TTS 引擎 (`tts.js`)。
- **🔌 灵活适配层 (Flexible Adapters)**: 无缝对接网易云音乐 (NCM)、兼容 OpenAI 格式的大语言模型、Fish TTS/StepFun，并预留了天气、日历和 UPnP 占位适配器。
- **🔄 运行时聚合 (Runtime Aggregation)**: 动态聚合提示词、用户语料、环境注入信息，通过日志记忆和执行轨迹进行上下文追踪。
- **💻 多维交互 (Multi-Channel Interaction)**: 提供 PWA Web App、标准的 HTTP RESTful API 以及用于流式输出的 WebSocket (`/stream`)。

## 🏗️ 架构设计 (Architecture)

Sonora 采用清晰的分层架构设计：

1. **本地大脑层**: `router.js`, `context.js`, `agent.js`, `scheduler.js`, `tts.js`
2. **外部适配层**: Netease Cloud Music, OpenAI-compatible LLM, Fish TTS / StepFun TTS, 天气/日历/UPnP
3. **运行时聚合层**: 提示词, 用户语料, 环境注入, 日志记忆, 执行轨迹
4. **交互层**: PWA Web App, HTTP API, `/stream` WebSocket

## 🚀 快速开始 (Getting Started)

### 1. 运行项目 (Run)

确保你已经安装了 Node.js，然后在项目根目录下运行：

```bash
npm start
```

服务启动后，在浏览器中打开 [http://localhost:8080](http://localhost:8080) 即可开始体验。

> **💡 提示**: 即使没有配置任何外部服务，系统也会使用内置的降级逻辑和示例歌曲，你仍然可以完整体验播放器、聊天、计划、偏好设置和实时事件。

### 2. 环境配置 (Optional Environment)

为了获得完整的 AI 体验，建议配置以下环境变量。你可以创建一个 `.env` 文件：

```bash
# --- LLM 配置 ---
OPENAI_BASE_URL=http://localhost:8000/v1
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL=qwen2.5

# --- 音乐服务配置 ---
NCM_BASE_URL=http://localhost:3000

# --- TTS 配置 (支持 StepFun 和 Fish Audio) ---
TTS_URL=https://api.stepfun.com/v1/audio/speech
TTS_API_KEY=your-tts-api-key
TTS_MODEL_ID=stepaudio-2.5-tts
TTS_VOICE_ID=cixingnansheng
TTS_EN_MALE_VOICE_ID=cixingnansheng
TTS_YUE_FEMALE_VOICE_ID=...

# --- 其他服务 ---
WEATHER_API_KEY=your-weather-api-key
```

**TTS 配置说明**:
- `provider` 会根据 `TTS_URL` 自动推断，支持 StepFun 和 Fish Audio。
- 主持人播报的 `instruction` 由代码根据歌曲语言自动生成，不需要写在环境变量里。
- 旧的 `STEP_*` / `FISH_*` 变量仍会被读取作为兼容兜底。

## 📡 API 契约 (API Contract)

Sonora 提供了丰富的接口供外部调用和集成：

| 方法 | 端点 (Endpoint) | 描述 (Description) |
| :--- | :--- | :--- |
| `GET` | `/api/now` | 获取当前播放状态和电台上下文 |
| `GET` | `/api/taste` | 获取用户的音乐偏好数据 |
| `GET` | `/api/plan/today` | 获取今天的电台播放计划 |
| `POST`| `/api/chat` | 与 AI 主持人进行对话聊天 |
| `POST`| `/api/player/play` | 播放音乐 |
| `POST`| `/api/player/pause`| 暂停音乐 |
| `POST`| `/api/player/next` | 播放下一首 |
| `POST`| `/api/taste/import`| 导入外部音乐偏好数据 |
| `WS` | `/stream` | WebSocket 流式数据输出 (音频流/日志流) |

## 🤝 贡献 (Contributing)

欢迎提交 Issue 和 Pull Request 来帮助改进 Sonora！无论是修复 Bug、添加新特性，还是改进文档，我们都非常感激。

## 📄 许可证 (License)

本项目采用 [MIT License](LICENSE) 开源协议。

<div align="center">
  <br />
  <i>构建属于你自己的 AI 声音世界 🎵</i>
</div>
