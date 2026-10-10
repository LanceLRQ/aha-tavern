# 使用指南

这份指南带你从安装开始，开一间酒馆、建第一个角色、聊上天。

## 1. 安装

需要先装好 DSH，并准备一个能用的模型。

阿哈酒馆还没发布到 npm，先自己打一个安装包：

```bash
pnpm install
pnpm build
pnpm pack
```

会得到 `aha-tavern-0.0.1.tgz`。把它装进你用的 profile（下面以 `web` 为例）：

```bash
dsh plugin --profile web add ./aha-tavern-0.0.1.tgz
```

重启 DSH（`dsh web`）。新建会话时，模式列表里会多出两个：

- **酒馆:筹备**：开店、建角色、写主角档案
- **酒馆:单聊**：和一个角色聊天

升级时重新 `add` 新的 tgz 即可。同名同版本的包可能被缓存，换个文件名再装。

## 2. 开店

酒馆就是一个文件夹。你在 DSH 里选哪个文件夹作工作区，哪个文件夹就是酒馆。

1. 新建会话，选工作区文件夹，模式选"酒馆:筹备"。
2. 输入：

```
/aha 启动
```

3. 掌柜会问你想被怎么称呼，要不要写主角档案。想跳过就说"跳过"。

工作区里没有酒馆时，筹备会说明这里还不是酒馆，并列出你开过的其他酒馆。

## 3. 建第一个角色

还在"酒馆:筹备"里：

```
/aha 角色 白狐
```

或者直接说："帮我建一个角色，名字叫白狐，嘴硬心软的狐狸酒馆老板娘。"

掌柜会补全细节。写入前会弹出一张卡片，让你选"保存"或"先不保存"。不满意就选后者，接着说哪里要改。

想让角色认识你，可以写主角档案：

```
/aha 我
```

## 4. 开始聊天

新开一个会话，模式选"酒馆:单聊"，工作区选同一个酒馆文件夹：

```
/aha 开场 白狐
```

角色会说出开场白，之后直接打字聊天就行。

名字不用打全。`/aha 开场 狐` 也能找到白狐；如果对上了不止一个角色，会弹出一张卡片让你点。不带名字的 `/aha 开场` 会列出酒馆里的全部角色。直接打字说"我找白狐"也一样。

要聊另一个角色，或者重新开始，就新开一个单聊会话。

## 5. 让角色记住事情

有两种办法：

- **随口说**：聊天里直接说"记住：我不吃香菜"。角色会自己判断要不要记下来。
- **用命令**：

```
/aha 记忆 我下周要去山里写生
```

不带内容的 `/aha 记忆`，会让角色回顾这次聊天并整理记忆。

记忆存在角色文件夹里的 `memory.md`，是普通文本，你可以直接打开看、改。下次开场时，角色会带着这些记忆和你聊。

## 6. 让角色画图

配好 ComfyUI 后，角色会在值得留下的时刻先画一张图，再写这一轮的回复，图片显示在回复末尾。你也可以直接说"画一张"。

```
/aha 重新生图
/aha 重新生图 换成雪夜，撑一把红伞
```

前者按原画面换一张；后者带上修改要求，角色会改写画面描述后重画。没配置生图也能正常聊天，只是角色不会画图。配置方法见[配置生图](image-setup.md)，用 `/aha 自检 生图` 可以查看配得对不对。

## 7. 让角色开口

配好语音服务后，角色的台词可以念出来。这里只写最短的路径，细节和常见问题见[配置语音](voice-setup.md)。需要苹果芯片的 Mac 和 uv。

1. 在 `~/.dsh/aha-tavern/services.yaml` 里写 `voice` 一节：

```yaml
voice:
  endpoint: http://127.0.0.1:18123
  launch: mlx
```

2. 在任一模式里输入 `/aha 语音 启动`。第一次会装运行环境、下载模型（约 2GB），先弹卡片让你确认；用 `/aha 语音 状态` 看进度。
3. 在"酒馆:筹备"里对掌柜说："给白狐配声音。"你可以给他一段 3 到 15 秒的录音和录音里逐字说的话，也可以让他按角色卡里的 `voice` 栏描述设计一个，试听后选用。
4. 在"酒馆:单聊"里输入 `/aha 朗读`，念上一条回复；`/aha 朗读 开` 打开自动朗读。

没配语音也能正常聊天，只是角色不出声。用 `/aha 自检 语音` 可以查看配得对不对。

## 8. 数据在哪

全都在酒馆文件夹里，删掉文件夹就是删掉这间酒馆：

```
酒馆/
├── aha-tavern.yaml     # 标记文件，有它才算酒馆
├── world.md            # 世界观
├── me.md               # 主角档案
├── characters/
│   └── 白狐/
│       ├── character.yaml   # 角色卡
│       ├── voice_ref.wav    # 角色的声音（参考录音），配过声音才有
│       ├── voice_ref.txt    # 录音里说的话
│       └── memory.md        # 角色的记忆
├── chats/
│   └── 20261009-1223-白狐-21fl/
│       ├── chat.jsonl       # 聊天原文，一句一行
│       ├── summary.md       # 往事梗概（整理过才有）
│       ├── meta.yaml
│       ├── images/          # 生成的图片（001.png……），出过图才有
│       └── images.jsonl     # 每张图的画面描述、种子、尺寸等
└── .aha/
    └── sessions.yaml        # 会话状态
```

另有一份很小的登记表 `~/.dsh/aha-tavern/taverns.yaml`（设了 `DSH_HOME` 时在 `$DSH_HOME/aha-tavern/` 下），只记你开过哪几间酒馆（名字和路径），方便在别的工作区里找到它们。

卸载插件不会动这些数据。已有的酒馆会话还能翻看，但不能继续聊；重新装回后就能接着聊。

## 9. 换主题

主题决定掌柜怎么说话、各种东西叫什么。自带两套：

- `fools`：愚者，默认
- `plain`：直白

在你的 profile 的 `cordis.patch.yml` 里设置（路径是 `$DSH_HOME/profiles/<名>/cordis.patch.yml`，默认 `~/.dsh/profiles/<名>/cordis.patch.yml`）。要把两个模式整条覆盖，每个模式的 `aha-tavern` 里都加上 `theme`：

```yaml
- id: preset-tavern-setup
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: tavern-setup
    name: '酒馆:筹备'
    description: 开店、建角色卡、写主角档案、写世界观、导入。
    order: 5
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: 你是阿哈酒馆的主持人，只负责筹备，不是通用助手；怎么称呼自己、能做什么，以下文为准。
          includeRuntimeContext: false
      - id: tool-ask-user
        name: '@deepseek-ai/dsh-tool-ask-user'
      - id: aha-tavern
        name: aha-tavern
        config:
          mode: setup
          theme: plain
      - id: mcp-websearch
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          serverName: websearch
          transport: stdio
          command: npx
          args: ['-y', 'open-websearch@2.2.0']
- id: preset-tavern-chat
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: tavern-chat
    name: '酒馆:单聊'
    description: 和一个角色聊天。
    order: 6
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: 你是阿哈酒馆里的一员，不是通用助手：选定角色之前负责接待，之后扮演选定的角色；具体以下文为准。
          includeRuntimeContext: false
      - id: tool-ask-user
        name: '@deepseek-ai/dsh-tool-ask-user'
      - id: aha-tavern
        name: aha-tavern
        config:
          mode: chat
          theme: plain
```

改完重启 DSH。主题只换称呼和口吻，命令名、文件名、数据格式都不变。

## 10. 关掉自带的联网搜索

"酒馆:筹备"自带联网搜索，方便掌柜查资料来建角色卡。不想要它，就用第 9 节同样的办法覆盖 `preset-tavern-setup`，把 `mcp-websearch` 那一段删掉：

```yaml
- id: preset-tavern-setup
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: tavern-setup
    name: '酒馆:筹备'
    description: 开店、建角色卡、写主角档案、写世界观、导入。
    order: 5
    plugins:
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: 你是阿哈酒馆的主持人，只负责筹备，不是通用助手；怎么称呼自己、能做什么，以下文为准。
          includeRuntimeContext: false
      - id: tool-ask-user
        name: '@deepseek-ai/dsh-tool-ask-user'
      - id: aha-tavern
        name: aha-tavern
        config:
          mode: setup
```

只写 `preset-tavern-setup` 这一条就行，另一个模式不用动。改完重启 DSH。"酒馆:单聊"本来就没有联网工具。
