# WeChat Claude Bridge

WeChat 与 Claude AI 的桥接服务，通过微信消息接口实现与 AI 的对话。

## 功能

- 文字对话：支持中英文多轮对话
- 图片分析：发送图片由 AI 识别描述
- 视频分析：发送视频由 AI 分析内容
- 语音识别：语音消息自动转文字并回复
- 语音回复：TTS 合成语音消息回复
- 联网搜索：自动检测需要联网查询的问题
- 天气查询：自动获取天气实况数据
- 表情绑定：自定义表情触发命令

## 快速开始

### 环境要求

- Node.js >= 18
- 微信账号（支持 iLink 接口）

### 安装

`ash
npm install
`

### 配置

复制 .env.example 为 .env，填入配置：

`ash
cp .env.example .env
`

主要配置项：

- ANTHROPIC_API_KEY：AI 服务 API Key
- ANTHROPIC_API_URL：API 地址（可选）
- CLAUDE_MODEL：使用的模型名称

### 登录

`ash
npm run login
`

扫描二维码完成微信登录。

### 启动

`ash
npm start
`

## 命令

在微信中发送以下命令：

| 命令 | 说明 |
|------|------|
| /clear 或 /delete | 重置对话历史 |
| /status | 查看系统状态 |
| /voice | 切换语音回复模式 |
| /help | 显示帮助信息 |
| /bindings | 查看表情绑定 |
| /bind [表情] /命令 | 绑定表情到命令 |
| /unbind [表情] | 解除表情绑定 |

支持自然语言清除对话，如发送"清除聊天记录"、"删除对话"等。

## 项目结构

`
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
`

## 许可

MIT
