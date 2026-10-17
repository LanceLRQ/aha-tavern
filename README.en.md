# Aha Tavern

[中文](README.md) | English

> A DSH plugin for role-play chat, group scenes, book writing, illustrations and voiced dialogue.

## Introduction

<p align="center"><img src="docs/aha-tavern.webp" alt="Aha Tavern" width="320"></p>

Aha Tavern is a plugin for DSH (DeepSeek Harness). It turns role-play into a few "modes" inside a coding agent, instead of being a separate web app. You pick a folder as your tavern, create characters in it, chat with them, stage group scenes with several characters, and finally turn the stories you have played into a book.

When the story reaches a moment worth keeping, the character calls your ComfyUI to draw a picture. Once a voice service is set up, each character speaks their lines in their own voice. Image generation and voice are external services that you run yourself; the plugin only orchestrates them. Chats, memories, images and manuscripts are plain files in the tavern folder, and they stay put if you uninstall the plugin.

> **Project status: text chat, group chat and book writing all work, and so do images and voiced dialogue.** You can already open a tavern, create character cards, write your player profile, chat one-on-one, run group scenes, write your stories into a book, and let characters remember things. With ComfyUI set up, characters can draw pictures as the story goes; with a voice service set up, their lines can be read aloud. The project is at an early stage, and feedback is welcome.

## Four modes

The mode names appear in the DSH interface in Chinese, so they are shown below with the original text in parentheses.

| Mode | What it does |
|---|---|
| **Tavern: Setup** (酒馆:筹备) | Open a tavern, create character cards, write your profile and the world, make reference sheets and set up voices for characters, import from another tavern |
| **Tavern: Chat** (酒馆:单聊) | Chat with one character who remembers what happened between you |
| **Tavern: Group** (酒馆:群聊) | Several characters on stage, one model plays them all, and a narrator sets the scene |
| **Tavern: Book** (酒馆:写书) | Turn several past chats into a book, and optionally rewrite it as a novel |

A session does one thing: whichever mode you pick is all it does. Each mode loads only the tools it needs, with no coding tools, and the system prompt stays small.

## Features

**Characters and memory**

- A character card defines the persona, speaking style and opening line. You can describe a character to the host in a sentence, paste an existing persona, or give an image and let the host draft the card from it (the model must accept image input)
- Setup has built-in web search (can be turned off), so the host can look things up when you create a card for a character from an existing work
- Memory has three layers: core memory is always in the prompt, recaps are recalled on demand, and the transcript is written to disk line by line. Characters note down what matters on their own, and you can also tell them to remember something with a command
- Chat and group chat share memory: what happened in a group scene is remembered by the characters later in one-on-one chat, and they can recall it

**Group chat**

- Decide who is present and what the scenario is, then start. The narrator's lines start with 【旁白】 (narrator), characters' lines start with "Name:", and at most three characters speak per turn
- `@name` makes only that one character respond; `/aha narrator` changes the situation, and the characters cannot hear the request
- When the place or time changes, the narrator asks whether to change scene. A scene change can bring people in or out, and at wrap-up the scene gets a title

**Book writing**

- Choose some chats and a point of view; the editor drafts an outline, and you refine it in conversation
- The plugin then writes the draft section by section in the background: dialogue is mostly verbatim, with commands and out-of-character parts removed
- You can then rewrite it as a novel in a style you describe: merge and reorder sections, add a preface
- Any section can be rewritten on its own, and the whole book exports as one Markdown file

**Images**

- Draw first, then speak: the image shows on the first line of the reply, with the text below it. Characters only draw at moments worth keeping, not during small talk
- Give a character a three-view reference sheet and every later image follows it, so the face stays consistent. You can add more looks when needed
- Group chat has two kinds of images: scene images and single-character close-ups
- You can also just say "draw one", or use `/aha reroll` to get another one or to change the picture on request

**Voice**

- Every character has their own voice: bring a recording, or have the host design one from a description
- Read aloud by hand, or automatically every turn. Actions and expressions in parentheses are not read; in group chat the narrator and each character use their own voices
- On an Apple-silicon Mac the plugin can install and start a local voice service (Qwen3-TTS) for you; on other platforms it connects to an OpenAI-compatible voice service you run yourself

**Themes**

- Two built-in sets of terms and tone: "Fools" (愚者, the default) and "Plain" (直白). They change names and wording only, not your data

## Installation

Download the package from the [v0.1.0-rc1 prerelease](https://github.com/LanceLRQ/dsh-aha-tavern/releases/tag/v0.1.0-rc1) and install it into the profile you use (`web` below):

```bash
curl -fLO https://github.com/LanceLRQ/dsh-aha-tavern/releases/download/v0.1.0-rc1/aha-tavern-0.1.0-rc1.tgz
dsh plugin --profile web add ./aha-tavern-0.1.0-rc1.tgz
```

The release also includes a `.sha256` checksum file. To upgrade, download the new package and run the same `add` command.

Restart `dsh web`. When you create a new session, the mode list now has four tavern modes. If you installed with `dsh plugin add`, the plugin page also has an "Aha Tavern" (阿哈酒馆) settings page, where you can change the image and voice settings and start or stop the local voice service. For the full steps see the [Getting started guide](docs/en/getting-started.md).

You need:

- DSH (tested with `0.2.0-rc.2` and `0.2.1-rc.1`)
- A working model (local or online)
- To let characters draw: a ComfyUI, see [Image setup](docs/en/image-setup.md)
- To let characters speak: an Apple-silicon Mac with uv, or an OpenAI-compatible voice service you run yourself, see [Voice setup](docs/en/voice-setup.md)

Chat works without the last two; characters just don't draw or speak.

## Usage

First open a tavern and create a character in Tavern: Setup, then start a new Tavern: Chat session and begin:

```
/aha init
/aha card 白狐
```

(白狐 is an example character name.)

```
/aha start 白狐
...
/aha remember I don't eat cilantro
```

For group chat and book writing, open a new session each, pick the matching mode, and choose the same tavern folder as the workspace. In group chat, use `/aha start` to decide who is present and what the scenario is. For book writing, use `/aha book` to choose the chats to include, then work out the outline with the editor in conversation and start writing.

Subcommands accept both Chinese and English, and can also be written as standalone commands: `/aha 开场` = `/aha start` = `/aha-start`. The examples in the English docs use the English forms.

| Command (Chinese) | Command (English) | Mode | What it does |
|---|---|---|---|
| `/aha 启动` | `/aha init` | Setup | Turn the current workspace into a tavern |
| `/aha 角色 [name]` | `/aha card [name]` | Setup | Create or edit a character card |
| `/aha 我` | `/aha me` | Setup | Write or edit your player profile |
| `/aha 世界观` | `/aha world` | Setup | Write or edit the world |
| `/aha 定妆 [name]` | `/aha look [name]` | Setup | Make a reference sheet for a character; later images follow it |
| `/aha 导入` | `/aha import` | Setup | Copy character cards or your profile from another tavern |
| `/aha 开场 [name…] [scenario]` | `/aha start [name…] [scenario]` | Chat, Group | Chat: pick a character and start. Group: decide who is present and the scenario, and start a scene |
| `/aha 旁白 [request]` | `/aha narrator [request]` | Group | Have the narrator change the surroundings or the situation, e.g. `/aha narrator make the mood tense` |
| `/aha 换场 [new scenario] [who comes or goes]` | `/aha scene [new scenario] [who comes or goes]` | Group | Change scene; people can join or leave at the same time |
| `/aha 收场` | `/aha wrap` | Group | Write a recap and a title for this scene; you can keep chatting afterwards |
| `/aha 记忆 [text]` | `/aha remember [text]` | Chat, Group | Note one sentence, or have the character review and organize memory; in group chat use `@name` to tell only one person |
| `/aha 重新生图 [change request]` | `/aha reroll [change request]` | Chat, Group | Redraw the previous picture; with a change request, the character rewrites the scene description and redraws |
| `/aha 朗读 [text\|on\|off\|stop]` | `/aha speak [text\|on\|off\|stop]` | Chat, Group | Read the last reply or the given text aloud; `on` / `off` (Chinese: `开` / `关`) toggle auto-read for this chat, `stop` (`停`) stops reading |
| `/aha 写书 [title]` | `/aha book [title]` | Book | Start a book: choose the chats to include and the point of view |
| `/aha 进度` | `/aha progress` | Book | See how far the book has got |
| `/aha 停笔` | `/aha pause` | Book | Stop the section being written; finished sections are kept |
| `/aha 导出 [draft\|novel]` | `/aha export [draft\|novel]` | Book | Assemble the whole book into Markdown files; without an argument both are exported (Chinese: `整理稿` / `小说`) |
| `/aha 自检` | `/aha doctor` | Any | Check the current state; `/aha doctor image` and `/aha doctor voice` (Chinese: `生图` / `语音`) show details |
| `/aha 语音 [start\|stop\|status]` | `/aha voice [start\|stop\|status]` | Any | Start, stop or check the local voice service (Chinese: `启动` / `停止` / `状态`) |

The Chinese subcommands have a few synonyms with the same effect: `启动` can also be written `开店` or `开张`; `角色` can also be written `角色卡` or `建卡`; `记忆` can also be written `记住`; `朗读` can also be written `说话`; `重新生图` can also be written `重掷`.

## Where your data lives

The tavern is the folder you pick as the workspace. It holds the characters (`characters/`), chats (`chats/`), books (`books/`), the world and your profile, all as plain YAML, JSONL, Markdown and image files that you can open, edit and back up directly. The only global file is a small registry, `~/.dsh/aha-tavern/taverns.yaml`, which lists the taverns you have opened. For the directory layout see "Where your data lives" in the [Getting started guide](docs/en/getting-started.md).

## Documentation

- [Getting started](docs/en/getting-started.md): install, open a tavern, create characters, chat, memory, group chat, book writing, images, voice, data layout, themes
- [Image setup](docs/en/image-setup.md): ComfyUI model files, `services.yaml`, self-check, GGUF, built-in workflows, reference sheets, troubleshooting
- [Voice setup](docs/en/voice-setup.md): starting and downloading the local voice service, giving characters voices, reading aloud, self-check, running your own voice service, troubleshooting

## Development

```bash
pnpm install
pnpm build       # bundle the plugin and the settings page
pnpm test        # unit tests
pnpm typecheck   # type check
pnpm pack        # build and create the plugin package
```

To publish, update the version in `package.json` and push a matching `v<version>` tag. GitHub Actions checks the version, runs type checking and unit tests, then packages the plugin and creates a release. Versions with a prerelease suffix are marked as prereleases.

For local debugging you don't need to install: copy `examples/dev.example.yml` to `examples/dev.yml`, change the paths in it to absolute paths of this repository, then start with `dsh web --patch <absolute path>/examples/dev.yml`. The settings page is not visible this way.

## Contributing

Issues for discussion are welcome. Please open an issue to align on direction before sending a PR.

## License

Apache-2.0. See [LICENSE](./LICENSE).
