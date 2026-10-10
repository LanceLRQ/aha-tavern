# 阿哈酒馆 Aha Tavern

在编码智能体里开酒馆的插件：聊天，插画，文字转声音。

## 项目一句话定义

一个 DSH（DeepSeek Harness）插件，为角色扮演与互动叙事提供三样东西：沉浸式角色扮演聊天、按剧情调用 ComfyUI 生图、台词语音合成。

类比：把"角色扮演前端"做成智能体 harness 里的一个模式，而不是另起一个 Web 应用。它不是模型网关，也不内置生图或语音模型——这些都是外部服务，插件只做编排。

## 核心设计要点

- **原生 Cordis 插件**：以 npm 包形式分发的 DSH 插件，直接注册工具、斜杠命令、事件监听和系统提示词段；不走 MCP server + hooks（钩子拿不到回复文本）。
- **自带"酒馆模式"**：一个与标准模式并列的 agent 模式，只挂酒馆人设和酒馆插件，不挂编码工具，系统提示词保持精简。
- **核心与外壳分离**：生图、语音、存储、角色卡、记忆等逻辑放在与 harness 无关的 `core/`，插件外壳只做接线，便于日后移植。
- **盘上是真相**：对话逐条追加落盘，图片与文本分离存放；数据目录在插件包之外，卸载插件不丢数据。
- **记忆走系统提示词段，不做每轮注入**：角色卡、叙事规范、上一场摘要在开场时注册、谢幕时撤销，不随轮次累积。
- **对外名字只增不改**：模式 id、工具名、命令名会写进会话历史，改名会让旧会话失效或静默出错。

## 技术栈

- **语言与运行时**：TypeScript，Node.js
- **宿主**：DSH（DeepSeek Harness），Cordis 插件体系
- **外部服务**：ComfyUI（生图）、OpenAI 兼容的语音合成端点（默认 Qwen3-TTS；苹果芯片的 Mac 上插件可代为启动本机 mlx-audio，其他平台自备服务）
- **数据格式**：YAML（角色卡、会话元数据）、JSONL（对话与生图记录）

## 实现现状

一期（文字版）已完成：四个模式里实现了"酒馆:筹备"与"酒馆:单聊"；群聊、写书在后续阶段。

- [x] 调研与设想稿、宿主能力验证
- [x] M0 文字版：开店、角色卡、主角档案、世界观、导入、单聊开场、对话落盘、记忆（随手记 / 整理 / 回忆）、两套主题
- [x] M1a 生图：基础工作流 + 生图工具 aha_draw + 自检
- [ ] M1b 一致性：身份注入工作流 + 自检
- [ ] M1.5 一图成卡
- [x] M2 语音：M2a 自备录音配声音 + 朗读（手动 / 自动）+ 本机语音服务启停，M2b 音色设计，设置页（插件页里改语音与生图配置、启停语音服务）
- [ ] M3 记忆闭环
- [ ] M4 打磨

## 仓库结构

```
aha-tavern/
├── package.json          # npm 包清单；dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 向 DSH profile 插入两个酒馆模式（筹备、单聊）和一行设置页实例
├── scripts/build.mjs     # esbuild 打成三个产物：dist/index.js（插件，提示词 .md 内联）、dist/client.js（设置页）、dist/typert.host.js（设置页的远程方法描述）
├── assets/               # 随包资源（语音预热与自检用的参考录音 voice-ref.wav）
├── src/
│   ├── index.ts          # 插件入口
│   ├── config.ts         # 插件配置项与默认值
│   ├── typert-host.ts    # 包的 ./typert 导出，宿主据此发现设置页的远程服务
│   ├── core/             # 与 harness 无关的核心逻辑（角色卡、记忆、聊天落盘、登记表、主题……）
│   ├── shell/            # 接到 DSH 上的外壳：命令、工具、提示词段、事件监听、朗读与语音服务启停、设置页后端
│   ├── client/           # 设置页的前端（插件页里的"阿哈酒馆"）
│   ├── shared/           # 设置页前后端共用的类型
│   └── prompts/          # 提示词文本
├── workflows/            # 内置 ComfyUI 工作流（qwen-image-2.1、qwen-image-2.1-gguf），末尾 _aha 段说明填值位置与模型
├── themes/               # 内置称呼主题（fools 愚者、plain 直白），运行时按 dist/../themes 读取
├── examples/             # 本机调试用的叠加配置模板
├── test/                 # vitest 单元测试
├── docs/                 # 面向使用者的文档（getting-started.md、image-setup.md、voice-setup.md）
│   └── superpowers/specs/  # 定稿后可公开的设计规格
└── LICENSE               # Apache-2.0
```

## 常用命令

```bash
pnpm build       # 打成 dist/index.js
pnpm test        # 跑单元测试
pnpm typecheck   # 类型检查
pnpm pack        # 打成 aha-tavern-<版本>.tgz，用 dsh plugin --profile <名> add 安装
```

本机调试：`pnpm build` 后，复制 `examples/dev.example.yml` 为 `examples/dev.yml`，改好里面的绝对路径，再用 `dsh web --patch <绝对路径>/examples/dev.yml` 启动。这种方式下看不到设置页，要看设置页得用 `dsh plugin add` 安装。

命令形态（插件内的斜杠命令，中英文子命令等价，也可以写成 `/aha-<英文子命令>`）：

```
/aha 启动 | init              把当前工作区变成一间酒馆（筹备）
/aha 角色 | card [角色名]     新建或修改角色卡（筹备）
/aha 我 | me                  写或改主角档案（筹备）
/aha 世界观 | world           写或改世界观（筹备）
/aha 导入 | import            从另一间酒馆复制（筹备）
/aha 开场 | start [角色名]    选定角色，开始聊天（单聊）
/aha 记忆 | remember [内容]   记一句话，或让角色回顾并整理记忆（单聊）
/aha 自检 | doctor            检查当前状态；/aha 自检 生图 | 语音 看详情
/aha 重新生图 | reroll [修改要求]   按原画面重画，或按修改要求改写后重画（单聊）
/aha 朗读 | speak [文字|开|关|停]   念上一条回复或给定的文字；开/关自动朗读，停止朗读（单聊；/aha 说话 同义）
/aha 语音 | voice [启动|停止|状态]  启动、停止或查看本机语音服务
```
