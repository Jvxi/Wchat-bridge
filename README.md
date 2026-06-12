<p align="center">
  <strong>WeChat Claude Bridge</strong>
</p>

<p align="center">
  <a href="https://github.com/Jvxi/Wchat-bridge"><img src="https://img.shields.io/badge/language-TypeScript-3178c6.svg?style=flat-square&labelColor=161b22&logo=typescript&logoColor=white" alt="TypeScript"/></a>
  <a href="https://github.com/Jvxi/Wchat-bridge"><img src="https://img.shields.io/badge/runtime-Node.js-339933.svg?style=flat-square&labelColor=161b22&logo=nodedotjs&logoColor=white" alt="Node.js"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Jvxi/Wchat-bridge.svg?style=flat-square&labelColor=161b22" alt="license"/></a>
  <a href="https://github.com/Jvxi/Wchat-bridge/stargazers"><img src="https://img.shields.io/github/stars/Jvxi/Wchat-bridge.svg?style=flat-square&color=dbab09&labelColor=161b22&logo=github&logoColor=white" alt="GitHub stars"/></a>
</p>

<br/>

<h3 align="center">WeChat 与 AI 的桥接服务，让你在微信里直接对话 AI。</h3>
<p align="center">支持多轮对话、图片/视频分析、语音识别与合成、联网搜索、天气查询。</p>

<br/>

## 功能

| 功能 | 说明 |
|---|---|
| 文字对话 | 支持中英文多轮上下文对话 |
| 图片分析 | 发送图片由 AI 识别描述 |
| 视频分析 | 发送视频由 AI 分析内容 |
| 语音识别 | 语音消息自动转文字并回复 |
| 语音回复 | TTS 合成语音消息回复 |
| 联网搜索 | 自动检测需要联网查询的问题并实时搜索 |
| 天气查询 | 自动获取天气实况数据 |
| 表情绑定 | 自定义表情触发命令 |

<br/>

## 工作原理

~~~
微信用户 <-> iLink API <-> Bridge 服务 <-> AI API
                                    |
                              +-----+-----+
                              |           |
                         对话历史管理   媒体处理
                        (持久化 JSON)  (图片/语音/视频)
~~~

Bridge 通过微信 iLink 接口监听消息，将文本/图片/语音/视频转发给 AI API，再将回复发回微信。对话历史按用户独立存储并持久化到本地 JSON 文件。

<br/>

## 快速开始

### 环境要求

- Node.js >= 22
- 微信账号（支持 iLink 接口）

### 安装

~~~bash
git clone https://github.com/Jvxi/Wchat-bridge.git
cd Wchat-bridge
npm install
~~~

### 配置

复制 `.env.example` 为 `.env`，填入配置：

~~~bash
cp .env.example .env
~~~

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI 服务 API Key（必填） | — |
| `ANTHROPIC_BASE_URL` | 第三方代理 API 地址 | 官方地址 |
| `CLAUDE_MODEL` | 模型名称 | `claude-sonnet-4-6` |
| `MAX_HISTORY_LENGTH` | 每用户最大对话历史条数 | `50` |
| `ASR_ENABLED` | 语音识别开关 | `true` |
| `WEB_SEARCH_ENABLED` | 联网搜索开关 | `true` |

### 登录

~~~bash
npm run login
~~~

扫描二维码完成微信登录。

### 启动

~~~bash
npm start
~~~

<br/>

## 命令

在微信中发送以下命令：

| 命令 | 说明 |
|---|---|
| `/clear` 或 `/delete` | 重置对话历史 |
| `/status` | 查看系统状态 |
| `/voice` | 切换语音回复模式 |
| `/help` | 显示帮助信息 |
| `/bindings` | 查看表情绑定 |
| `/bind [表情] /命令` | 绑定表情到命令 |
| `/unbind [表情]` | 解除表情绑定 |

支持自然语言清除对话，如发送"清除聊天记录"、"删除对话"等。

<br/>

## 项目结构

~~~
src/
  index.ts          # 入口
  bridge.ts         # 消息处理核心
  claude.ts         # AI 对话管理
  config.ts         # 配置
  auth.ts           # 认证
  iLink.ts          # 微信接口
  media.ts          # 媒体下载
  media-upload.ts   # 媒体上传
  tts.ts            # 语音合成
  emoji-bindings.ts # 表情绑定
~~~

<br/>

## 许可

MIT — 详见 [LICENSE](./LICENSE)

<br/>

---

<p align="center">
  <sub>Built by <a href="https://github.com/Jvxi">Jvxi</a></sub>
</p>