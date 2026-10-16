# Voice setup

[中文](../voice-setup.md) | English

This guide starts from a freshly set up Mac and takes you to the point where characters can speak. Just follow it in order.

Aha Tavern does not ship a voice model. On an Apple-silicon Mac, the plugin can install and start a local voice service for you (mlx-audio, using the Qwen3-TTS model by default). On other systems, or if you already have your own voice service, it can just connect to that. The chat model is not called while reading aloud, and audio files exist only in your tavern folder and the system temp directory.

Subcommands accept both Chinese and English (`/aha voice start` = `/aha 语音 启动`, `/aha speak on` = `/aha 朗读 开`). Receipt text and card buttons appear in Chinese in the interface, so they are shown with the original text in parentheses.

## 1. What you need

To let the plugin start the local voice service for you, you need:

- An Apple-silicon Mac (M series).
- [uv](https://docs.astral.sh/uv/). The plugin uses it to create the Python environment; it is enough that you can run `uv` in a terminal. If the machine has no Python 3.12, uv downloads one by itself into uv's own directory (not the weights directory described below), and so does its package cache.
- Disk: the runtime environment is about 0.44GB; the 0.6B model is about 1.9GB and the 1.7B model about 2.9GB; if you later use voice design, there is another design model of about 2.9GB to download.
- Memory: with the 0.6B model the service uses about 2.2GB once running steadily; loading the model and the first synthesis peak at about 8.7GB, so close memory-hungry apps in the meantime.
- Internet access to download the model (or a download mirror set up, see below).

On Windows and Linux the plugin does not start the service for you. You need to run a voice service yourself, see section 8.

## 2. Step 1: write services.yaml

The config file is shared with image generation:

```
~/.dsh/aha-tavern/services.yaml
```

If `DSH_HOME` is set, it lives at `$DSH_HOME/aha-tavern/services.yaml`. Create the directory and file if they don't exist.

The shortest form, letting the plugin start the service locally:

```yaml
voice:
  endpoint: http://127.0.0.1:18123
  launch: mlx
```

Without this file, or without `voice` / `endpoint`, voice counts as not configured. The file is read each time it is needed, so you don't have to restart DSH after editing it.

The full form is below, with the default value for each field. You can leave out any you don't want to change:

```yaml
voice:
  endpoint: http://127.0.0.1:18123   # required. Address of the voice service, must start with http:// or https://
  launch: none                       # mlx: allow the plugin to start it locally (endpoint must be a local address); none: connect only, don't start it
  model: 0.6b                        # 0.6b, 1.7b, or a full model name
  # modelsDir: ~/.dsh/aha-tavern/voice  # where the runtime environment and model weights go; an absolute path, may start with ~
  # hfEndpoint: https://hf-mirror.com   # mirror address for downloading models; the official source if omitted
  read: lines                        # lines: read dialogue only; all: read the whole passage
  pauseSeconds: 2                    # pause between passages (seconds): how long to pause when about 12 unread characters lie between them; more characters pause longer, fewer pause shorter; 0 means no pause
  pauseMinSeconds: 1                 # shortest pause between passages (seconds)
  pauseMaxSeconds: 4                 # longest pause between passages (seconds)
  language: chinese                  # language passed to the voice service
  timeoutSeconds: 120                # how many seconds to wait for one sentence to be synthesized at most
```

Notes:

- `launch` defaults to `none`, so to let the plugin start the service you must write `launch: mlx`. If `endpoint` is not a local address (`127.0.0.1`, `localhost` and the like), `mlx` is changed back to `none`.
- The port in the address is the port the service listens on; to change the port, change `endpoint`. Do not put a user name and password in the address.
- When `model` is `0.6b` or `1.7b`, the full model names are `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit` and `mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit`. 1.7B sounds better and uses more memory.
- If `modelsDir` is omitted, it is `~/.dsh/aha-tavern/voice` (`$DSH_HOME/aha-tavern/voice` if `DSH_HOME` is set). The runtime environment is under it in `env/`, the models in `hf/`, and the service log is `server.log`.
- `hfEndpoint` only affects model downloads. If the official source is very slow, change it to a mirror, such as `https://hf-mirror.com` above.

A field with a bad value falls back to its default, and the card of `/aha doctor voice` tells you which one.

`examples/services.example.yaml` in the repository has the same content, and you can copy it directly.

**You can also change it in the settings page.** Open `aha-tavern` (阿哈酒馆) on DSH's plugin page. It has two sections, "Voice" and "Image", where you fill in values, save, test the connection, and even start and stop the voice service. The page only saves the fields you changed, and comments and other fields in the file are kept (extra spaces before a trailing comment are collapsed into one). The settings page only appears when the plugin is installed with `dsh plugin add`; you won't see it when debugging with `--patch`.

## 3. Step 2: start the voice service

In chat, type:

```
/aha voice start
```

This works in any tavern mode. The first time, the runtime environment has to be installed and the model downloaded, so a card pops up first listing what will be installed, how big it is, where it goes and where it is downloaded from, and reminding you that memory use peaks at about 9GB while the model loads. Nothing happens until you click "Start" (开始), and if you click "Cancel" (取消), nothing is installed.

The flow after that has three steps: install the runtime environment (first time only) → start the service → download and load the model (the download happens only the first time). In our tests a fresh install took about 17 seconds, and the service answered about 4 seconds after starting; how long the model download takes depends on your network speed.

The start command waits at most 8 seconds. If it is not done within 8 seconds, it replies "语音服务正在启动" (the voice service is starting) and continues in the background. Check progress with:

```
/aha voice status
```

`/aha voice` with no argument is the same as status. Once started, the status says who started the service and which model it uses.

To stop the service:

```
/aha voice stop
```

Things to keep in mind:

- The plugin **never starts** the voice service by itself. Each time you have to type `/aha voice start` (or click "Start service" in the settings page).
- The service stops when DSH exits, including when you close the terminal or kill DSH, and no leftover process stays behind.
- `/aha voice stop` only stops a service the plugin started itself; it doesn't touch a service you started yourself.
- If a download is interrupted, `/aha voice start` again resumes it instead of starting over.

## 4. Step 3: give characters voices

Voices are set up in Tavern: Setup (酒馆:筹备), just by telling the host. There are two ways.

### Way 1: bring a recording

Tell the host you want to give a character a voice, and give it two things: the path of the recording file, and the words said in the recording.

The recording has requirements:

- 3 to 15 seconds.
- Only one person speaking, with a clean background.
- The text you give must match the recording **word for word**; don't change a single character. If unsure, transcribe the recording.

For example:

```
Give 白狐 a voice. The recording is at ~/Downloads/baihu.m4a, and it says: "今晚的酒不错，坐下来喝一杯吧。"
```

(白狐 is an example character name; the recording's words are in Chinese because the voice model is set to Chinese.) Write an absolute path, which may start with `~/`; relative paths are rejected. Formats such as mp3 and m4a are converted to wav automatically on a Mac. If the conversion fails, convert it by hand first:

```bash
afconvert -f WAVE -d LEI16@24000 -c 1 input-file output.wav
```

After it is registered, if the voice service is running, it says one sentence in the new voice, "你好，这是我现在的声音。" ("Hello, this is my voice now."), so you can hear it. It doesn't matter if the service is not started; the voice is already saved, and you can listen after starting it. If the character already has a voice, a card first asks you to confirm overwriting it.

### Way 2: no recording, let the host design one

Tell the host you want to design a voice for a character. It takes the description in the `voice` field of the character card (age feel, timbre, speed, tone), adds what you tell it, and pairs it with a sample line that fits the character's tone, then generates three samples for you to choose from. If the `voice` field is empty, it first works out a description with you.

Prerequisites:

- The voice service is started (run `/aha voice start` first).
- This machine is an Apple-silicon Mac and the service was started by the plugin (`launch: mlx`).

The process:

1. The first time, the design model (about 2.9GB) has to be downloaded, and a card asks you to confirm first. Memory use is about 5GB during design, with a peak of about 10GB while loading. From confirmation to the sample card appearing, the first time takes about one or two minutes (including the download), with no progress indicator in the interface in the meantime.
2. The three samples are given as a card, and you can listen to each repeatedly. If you are not satisfied, choose "Regenerate" (重新生成) for another batch from the same description (at most twice).
3. Pick one and click "Use this one" (用这一段), and it becomes the character's voice. Click "Cancel" to keep things as they were.
4. After design finishes, the voice service restarts once automatically to free memory.

Whichever way you use, the voice is stored in the character folder as `characters/<character name>/voice_ref.wav` and `voice_ref.txt` (the recording and the words said in it). To change the voice, set it up again, or replace these two files directly; replace them together.

## 5. Using it in chat

In both one-on-one and group chat you can use:

```
/aha speak
```

This reads the character's last reply aloud. To read other words:

```
/aha speak The moonlight is lovely tonight
```

To stop:

```
/aha speak stop
```

**Auto-read** makes the character read each turn by itself once it has spoken:

```
/aha speak on
/aha speak off
```

The switch is remembered per chat and is off by default. Each chat has its own switch, and when you continue it later it is still as you left it. When you send a new message, a reading that is still going on is interrupted.

The Chinese forms of the arguments also work: `开` for `on`, `关` for `off`, `停` for `stop`. The command name can also be written `/aha 朗读` or `/aha 说话`, with the same effect.

**What is read** is decided by `read`:

- `lines` (default): only dialogue is read. Action descriptions in parentheses (the content inside `（）`, `()` and `【】`) and actions wrapped in asterisks (`*pours a drink, head down*`) are not read.
- `all`: the whole passage is read, including what is in parentheses, with only image lines and Markdown markup removed.

To keep actions from being read, have the character write the actions in parentheses.

**In group chat**: the narrator and each character's lines within a turn are read in their own voices, one after another.

- The narrator uses the narrator voice that ships with the package. To use your own, point the plugin config `narratorVoiceDir` at a directory containing `voice_ref.wav` and `voice_ref.txt`, following the same convention as a character's voice. The config goes the same way as in the "Change the theme" section of the Getting started guide, in the `config` of the `aha-tavern` of the group mode:

```yaml
      - id: aha-tavern
        name: aha-tavern
        config:
          mode: group
          narratorVoiceDir: /your/narrator/voice/directory
```

- A character without a voice is skipped for those passages, and the receipt says so.
- `/aha speak` with no text reads all of the previous turn.
- The auto-read switch works like in one-on-one chat.

**Pauses**: between two passages to be read, if unread text (such as an action in parentheses) lies in between or the speaker changed, there is a pause before the next passage, to give you time to read that text. How long depends on the number of unread characters: with about 12 characters in between the pause is `pauseSeconds` (default 2 seconds); more characters pause longer, up to `pauseMaxSeconds` (default 4 seconds); fewer pause shorter, down to `pauseMinSeconds` (default 1 second); in between it changes smoothly. With the defaults, 3 characters pause about 1.3 seconds, 6 characters about 1.6 seconds, 24 characters about 2.7 seconds, 40 characters about 3.2 seconds; a plain change of passage with nothing skipped in between pauses about 1.4 seconds. All three values can be changed in `services.yaml` or the settings page, and must satisfy shortest ≤ `pauseSeconds` ≤ longest; setting `pauseSeconds` to 0 means no pause at all. Two consecutive sentences within one passage always pause 0.5 seconds. Sending a new message or `/aha speak stop` during a pause still stops immediately.

**Length limits**: at most about 1000 characters are read at a time, anything beyond is not read, and the receipt at the start of reading tells you; a single sentence over 80 characters is split at commas and enumeration commas before being read; sentences that are too short are merged with neighboring ones.

When `/aha speak` has no text and the latest reply has nothing readable (for example only an image), it reads an earlier one instead; if nothing in the whole chat is readable, the receipt is "这场聊天里还没有角色的话可念。" (there is nothing a character has said in this chat yet to read). When the text given to `/aha speak <text>` has nothing readable, the receipt is "没有可念的字。" (there is nothing to read).

## 6. Self-check

The self-check does not call the chat model.

**`/aha doctor`**: the status line includes a voice summary, in one of these common forms:

- `语音 可用` (voice available): configured, reachable, a player exists.
- `语音 未配置` (voice not configured): `services.yaml` was not found, or it has no `voice.endpoint`.
- `语音 未启动` (voice not started): the config is fine but the service is not reachable; use `/aha voice start`.
- `语音 启动中` (voice starting): it is starting.
- `语音 不可用：没有播放器` (voice unavailable: no player).

**`/aha doctor voice`**: a card pops up listing item by item: whether the service is reachable, who started it, whether the model is loaded, whether the runtime environment and model are installed, the player, whether the current character has a voice, and the error from the most recent reading, if any.

- When everything passes, the card has "Read a test sentence" (试念一句). Clicking it really reads one sentence, waiting up to a minute.
- When the service is not started and the plugin can start it, the card has "Start service" (启动服务), which goes through the same flow as `/aha voice start`.
- If something is wrong, fix it as instructed and click "Check again" (重新检查).

## 7. Playback

Sound is played with the system's own `afplay`, which needs no extra install on a Mac. Other systems need one of `ffplay`, `paplay` or `aplay`. When no player is found, the self-check says "没有找到播放器" (no player found).

Synthesized audio files go in the system temp directory first and are deleted once played; they don't stay in the tavern.

## 8. Other platforms, or your own voice service

On Windows and Linux the plugin cannot start the service for you. Run a voice service yourself, then let the plugin connect to it:

```yaml
voice:
  endpoint: http://your-service-address:port
  launch: none
  model: the model name in your service
```

The service must be OpenAI-compatible and support:

- `GET /v1/models`: used to detect whether the service is online.
- `POST /v1/audio/speech`: synthesizes speech. The request carries `model`, `input` (the sentence to read), `lang_code`, `response_format` (always `wav`), `stream` (always `false`, no streaming), `max_tokens`, and for voice cloning `ref_audio` (the path of the reference recording) and `ref_text` (the words said in the recording). It returns the complete wav audio.

Note: `ref_audio` is a **local file path**, so the voice service must be able to read files on the machine running DSH. If the service is on another machine, set up sharing, or make the paths the same on both sides.

With your own service, `/aha voice start` and `/aha voice stop` have no effect (the plugin only manages services it started itself), and voice design cannot be used; only Way 1, bringing a recording, works.

## 9. Troubleshooting

**Can't connect.** First use `/aha voice status` to see whether the service is running. If not, run `/aha voice start`. When the port is held by another voice service, starting suggests changing the port; when it is held by another program, the receipt is "语音服务启动后马上退出了" (the voice service exited right after starting), and `server.log` shows the port binding failure. In both cases, change the port in `endpoint`.

**Start times out or exits right away.** Look at `server.log` in the voice directory (by default `~/.dsh/aha-tavern/voice/server.log`); the last few lines usually give the reason. Common ones are not enough memory, a port conflict, or an incomplete model download.

**Download is slow, or was interrupted.** Set `hfEndpoint` in `services.yaml` to a mirror you can reach, then run `/aha voice start` again. The part already downloaded is resumed.

**It says uv was not found.** Install uv first (see the link above for the official method), then reopen DSH so it can find it in PATH.

**The voice sounds strange.** First check whether the character's recording text (`voice_ref.txt`) matches the recording word for word, with no missing, wrong or extra characters. Then check whether the recording is too long (over 15 seconds), has background noise, or has more than one person. Setting the voice up again usually fixes it. If not, try changing `model` to `1.7b`.

**I can't hear anything.** First use `/aha doctor voice` to check that the player, the character's voice and the service are all fine, then click "Read a test sentence" (试念一句). Make sure the system volume and output device are fine. If auto-read does nothing, use `/aha speak on` to make sure the switch is on.

**Not enough memory.** Memory peaks at about 9GB while the model loads, so close other big apps before starting; it drops to about 2.2GB once running steadily (0.6B). `model: 0.6b` uses less memory than `1.7b`. Voice design uses about 5GB with a peak of about 10GB, and the service restarts automatically afterwards to free memory.

**I want no voice at all.** Delete the `voice` section, or run `/aha voice stop` and don't start it again.
