# Getting started

[中文](../getting-started.md) | English

This guide takes you from installation to opening a tavern, creating your first character and starting a chat.

Subcommands accept both Chinese and English (`/aha start` = `/aha 开场`). The examples here use the English forms. Mode names and some card buttons appear in Chinese in the interface, so they are shown with the original text in parentheses on first use.

## 1. Install

Install DSH first and have a working model ready.

Aha Tavern is not on npm yet, so build a package yourself:

```bash
pnpm install
pnpm build
pnpm pack
```

You get `aha-tavern-0.0.1.tgz`. Install it into the profile you use (`web` below):

```bash
dsh plugin --profile web add ./aha-tavern-0.0.1.tgz
```

Restart DSH (`dsh web`). When you create a new session, the mode list now has four more entries:

- **Tavern: Setup** (酒馆:筹备): open a tavern, create characters, write your profile
- **Tavern: Chat** (酒馆:单聊): chat with one character
- **Tavern: Group** (酒馆:群聊): several characters on stage, with a narrator
- **Tavern: Book** (酒馆:写书): turn the stories you have played into a book

To upgrade, `add` the new tgz again. A package with the same name and version may be cached, so use a different file name when you reinstall.

## 2. Open a tavern

A tavern is a folder. Whichever folder you pick as the workspace in DSH becomes the tavern.

1. Create a new session, pick the workspace folder, and choose the mode "Tavern: Setup".
2. Type:

```
/aha init
```

3. The host asks how you want to be addressed and whether to write your player profile. Say "skip" if you want to skip it.

If the workspace is not a tavern yet, Setup tells you so and lists the other taverns you have opened.

## 3. Create your first character

Still in Tavern: Setup:

```
/aha card 白狐
```

(白狐 is an example character name, a fox who runs a tavern.) Or just say it in words: "Create a character named 白狐, a sharp-tongued, soft-hearted fox who runs a tavern."

The host fills in the details. Before anything is written, a card pops up for you to choose "Save" (保存) or "Not yet" (先不保存). If you are not happy, choose the latter and say what to change.

### Create a character from an image

If you have an image of the character, attach it to your message (add an attachment in the input box) and add a sentence:

```
Make a character from this image. She is the night watch of an old mountain academy, quiet, sharp-tongued but soft-hearted.
```

The host looks at the image to write the appearance, writes the personality and tone from what you said, and then shows you the whole card. You can also send just the image with no text. The host then pops up a card asking whether you want to say a few words yourself, let the host improvise from the image, or fill in only the appearance.

After the card is saved, the host asks a few follow-up questions. You can skip any of them or say "not now":

1. What the character calls you, and what your relationship is.
2. Whether to use this image as the reference sheet (needs [image setup](image-setup.md) first).
3. After the reference sheet, whether to give the character a voice (needs [voice setup](voice-setup.md) first).

Notes:

- **The model must accept images.** The model you use has to support image input, or messages with images cannot be sent, and the input box will tell you to switch to a model that supports images. If you declare models in your own config, add `input: [text, image]` to the model entry. If you have no image-capable model, you can skip the image and describe the looks yourself; the image path can still be used when you make the reference sheet.
- **Check the appearance.** The host only writes what it can see in the image, but it can miss or misread things. This appearance text is used later when drawing, and a mistake will clash with the reference sheet, so check it before saving.
- **Attach the image to the message.** If you only give a file path, the host cannot see the content; the path can only be used for the reference sheet.
- If you choose "fill in only the appearance", the personality field first gets the placeholder "not set yet" (尚未设定), because the character card requires this field not to be empty. Fill it in later.
- Editing an existing character works the same way: attach the image and say "change 白狐's appearance to match this image".

If you want the character to know you, write your player profile:

```
/aha me
```

## 4. Start chatting

Open a new session, choose the mode "Tavern: Chat", and pick the same tavern folder as the workspace:

```
/aha start 白狐
```

The character gives the opening line, and from there you just type to chat.

You don't need the full name. `/aha start 狐` also finds 白狐. If more than one character matches, a card pops up for you to click. `/aha start` with no name lists all characters in the tavern. Saying "I'm looking for 白狐" in plain text works too.

To talk to another character, or to start over, open a new chat session.

## 5. Make characters remember things

There are two ways:

- **Just say it**: say "Remember: I don't eat cilantro" in the chat. The character decides for itself whether to note it down.
- **Use the command**:

```
/aha remember I'm going to the mountains to sketch next week
```

`/aha remember` with no text makes the character review this chat and organize its memory.

Memory is stored in `memory.md` in the character's folder. It is plain text that you can open and edit. The next time you start a chat, the character talks to you with these memories.

## 6. Group chat

To put several characters on stage, open a new session, choose the mode "Tavern: Group", and pick the same tavern folder as the workspace.

**Start**: tell it who is present and the scenario together:

```
/aha start 白狐 青衫 It's my birthday today
```

(青衫 is another example character name.) You can also say it in words. If you give only the scenario and no names, a card pops up for you to select the characters present. After you choose, the plugin repeats "who is present, what the scenario is" for you to confirm, and the scene starts only when you confirm. At most 5 characters can be present (plugin config `groupCastMax`, default 5).

**What replies look like**: one model plays everyone. The narrator's lines start with 【旁白】 (narrator), and characters' lines start with "Name:" (the name followed by a colon). Each turn has at most one narrator passage and three characters speaking; who speaks depends on the situation and nobody is forced to talk.

**Addressing one character**: put `@name` in your message, for example `@白狐 what do you think`, and only 白狐 responds this turn, while the other characters stay out (the narrator can still speak).

**Narrator**: to change the surroundings or the situation, use

```
/aha narrator make the mood tense
```

The characters cannot hear this request; they only see that the situation has changed. The request stays in effect until the next scene change.

**Scene change**: when the narrator notices that the place or time has changed, a card pops up asking whether to change scene. You can also do it yourself:

```
/aha scene Next morning, outside the mountain gate. 青衫 leaves
```

Both the "new scenario" and "who comes or goes" parts can be left out.

**Wrap-up**:

```
/aha wrap
```

This writes a recap of the scene and gives it a title. You can keep chatting after wrap-up.

**Memory in group chat**:

- `/aha remember I don't eat cilantro` notes it for everyone present.
- `/aha remember @白狐 I don't eat cilantro` notes it for 白狐 only.
- `/aha remember` with no text has the narrator write the scene so far into a recap and organize the memory of the characters present.

What happens in a group chat goes into every participant's index of past events. If you later chat one-on-one with one of them, they remember these events and can recall them; they can only recall scenes they were present for.

## 7. Write a book

To turn the stories you have played into a book, open a new session and choose the mode "Tavern: Book". One session is one book; coming back to the session later means you are continuing to work on that book.

**Start a book**:

```
/aha book Mountain days with 白狐
```

The title is optional. A card pops up: tick the chats to include (the 20 most recent are listed), then choose the point of view to write in.

**Set the outline**: the editor drafts an outline (chapters and sections, each with a synopsis). You go back and forth in the conversation, and when you are happy, say "done" (定了) and the outline is saved.

**Start writing**: ask the editor to begin, and the plugin writes the draft section by section in the background.

```
/aha progress
/aha pause
```

`/aha progress` shows how far it has got; `/aha pause` stops the section being written, and finished sections are kept.

**Rewrite a section**: tell the editor "rewrite chapter 2 (3): less scenery description", and only that section is rewritten, the rest is untouched.

**Rewrite as a novel**: the draft follows the order of the chats. If you want a novel, tell the editor you want to rewrite it as a novel. The editor asks you to pick or describe a style and sets a separate novel outline. The novel outline can merge and reorder sections of the draft, and can add a preface. Once it is set, the sections are rewritten one by one, and you can rewrite any single section too.

**Export**:

```
/aha export
```

Without an argument both are exported, in the book's folder: the draft is `<title>.md`; the novel uses the novel's title as the file name, or `<title>（小说）.md` when it is the same as the book title. To export just one, write `/aha export draft` or `/aha export novel` (Chinese: `整理稿` or `小说`).

## 8. Let characters draw

Once ComfyUI is set up, characters draw a picture first at moments worth keeping, then write the reply for that turn. The image shows on the first line of the reply, with the text below it. You can also just say "draw one".

```
/aha reroll
/aha reroll change it to a snowy night, holding a red umbrella
```

The first redraws the previous picture; the second adds a change request, and the character rewrites the scene description and redraws.

To make every image of a character look the same, go back to Tavern: Setup and make a reference sheet for them:

```
/aha look 白狐
```

If you have an existing image, give its path to the host; if not, it draws from the appearance on the character card. When you are happy with a candidate, click "Save", and the images drawn in chat afterwards follow it. See the "Reference sheet" section of [Image setup](image-setup.md) for details.
Group chat can draw too: there are scene images that show the whole scene, and single-character close-ups of one character present. See "Using it in chat" in [Image setup](image-setup.md).
Chat works fine without image setup; characters just won't draw. See [Image setup](image-setup.md) for how to configure it, and use `/aha doctor image` to check whether it is set up correctly.

## 9. Let characters speak

Once a voice service is set up, characters' lines can be read aloud. This section only gives the shortest path; see [Voice setup](voice-setup.md) for details and troubleshooting. You need an Apple-silicon Mac and uv.

1. Add a `voice` section to `~/.dsh/aha-tavern/services.yaml`:

```yaml
voice:
  endpoint: http://127.0.0.1:18123
  launch: mlx
```

2. In any mode, type `/aha voice start`. The first time it installs the runtime environment and downloads the model (about 2GB), and asks you to confirm on a card first; use `/aha voice status` to see progress.
3. In Tavern: Setup, tell the host: "Give 白狐 a voice." You can give it a 3 to 15 second recording and the exact words said in it, or let it design one from the `voice` field of the character card, and pick one after listening.
4. In Tavern: Chat, type `/aha speak` to read the last reply aloud; `/aha speak on` turns on auto-read. Group chat works the same way: the narrator and each character are read in their own voices, see "Using it in chat" in [Voice setup](voice-setup.md).

Chat works without voice; characters just stay silent. Use `/aha doctor voice` to check whether it is set up correctly.

## 10. Where your data lives

Everything is in the tavern folder. Deleting the folder deletes the tavern:

```
tavern/
├── aha-tavern.yaml     # marker file; a folder is a tavern only if it has this
├── world.md            # the world
├── me.md               # your player profile
├── characters/
│   └── 白狐/
│       ├── character.yaml   # character card
│       ├── reference.png    # reference sheet, only if one was made
│       ├── looks/           # extra looks, only if any were added
│       ├── voice_ref.wav    # the character's voice (reference recording), only if a voice was set up
│       ├── voice_ref.txt    # the words said in the recording
│       └── memory.md        # the character's memory
├── chats/                   # one-on-one and group chats share one format
│   └── 20261009-1223-白狐-21fl/
│       ├── chat.jsonl       # the transcript, one line per utterance
│       ├── summary.md       # recap (only after it has been organized)
│       ├── meta.yaml
│       ├── images/          # generated images (001.png ...), only if any were drawn
│       └── images.jsonl     # scene description, seed, size etc. of each image
├── books/
│   └── 20261016-1030-白狐的山中日子-3k9d/
│       ├── book.yaml            # the book's settings
│       ├── outline.yaml         # outline of the draft
│       ├── draft/               # the draft, one file per section
│       ├── novel-outline.yaml   # outline of the novel (only after rewriting as a novel)
│       ├── novel/               # the novel, one file per section
│       └── 白狐的山中日子.md     # the exported book, only after an export
└── .aha/
    └── sessions.yaml        # session state
```

There is also a very small registry, `~/.dsh/aha-tavern/taverns.yaml` (under `$DSH_HOME/aha-tavern/` if `DSH_HOME` is set), which only records which taverns you have opened (name and path), so they can be found from other workspaces.

Uninstalling the plugin does not touch this data. Existing tavern sessions can still be browsed but not continued; once you reinstall, you can pick up where you left off.

## 11. Change the theme

A theme decides how the host speaks and what things are called. Two come built in:

- `fools`: Fools (愚者), the default
- `plain`: Plain (直白)

The `guofeng` (Chinese-style) theme uses the same terms as Plain and has no theme file of its own.

The theme is set in your profile's `cordis.patch.yml` (path `$DSH_HOME/profiles/<name>/cordis.patch.yml`, by default `~/.dsh/profiles/<name>/cordis.patch.yml`). You override the tavern mode definitions as whole entries:

1. Open this repository's `cordis.patch.yml` and copy out the four modes `preset-tavern-setup`, `preset-tavern-chat`, `preset-tavern-group` and `preset-tavern-book` as whole entries. To change the theme you need to change all four.
2. Paste them as they are into your own profile's `cordis.patch.yml`.
3. In each mode, add a line `theme: plain` to the `config` of the `aha-tavern` plugin. For Chat, for example:

```yaml
      - id: aha-tavern
        name: aha-tavern
        config:
          mode: chat
          theme: plain
```

Copy the whole entry, and don't leave out the `compaction` section at the end of each mode, or long chats lose compression. Restart DSH after the change. A theme only changes terms and tone; command names, file names and data formats stay the same.

## 12. Turn off the built-in web search

Tavern: Setup comes with web search, so the host can look things up when creating character cards. If you don't want it, use the same method as section 11, but copy only the `preset-tavern-setup` entry into your profile's `cordis.patch.yml` and delete the `mcp-websearch` section. Copy the rest as it is, and again don't leave out the `compaction` section.

The other modes need no change, as they have no web tools to begin with. Restart DSH after the change.
