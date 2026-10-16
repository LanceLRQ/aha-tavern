# Image setup

[中文](../image-setup.md) | English

This guide starts from a freshly installed ComfyUI and takes you to the point where chat produces images. Just follow it in order.

Aha Tavern does not ship an image model. It only hands the scenes from the story to your own ComfyUI. No other model is called while an image is generated, and images are stored only in your tavern folder.

Subcommands accept both Chinese and English (`/aha doctor image` = `/aha 自检 生图`). Receipt text and card buttons appear in Chinese in the interface, so they are shown with the original text in parentheses.

## 1. What you need

- A working ComfyUI. We tested with 0.38.0.
- A GPU with enough VRAM. Our test setup had 24GB, and about 15.5GB stays resident after an image is generated. With less VRAM, see "Use a GGUF quantized model" below.
- ComfyUI does not have to be on the same machine as DSH, as long as the machine running DSH can reach its address over HTTP (for example `http://127.0.0.1:8188`).
- Do not put a user name and password in the address.

## 2. Step 1: put the model files in place

The default workflow `qwen-image-2.1` needs three model files. Download them and put each into the matching directory under ComfyUI's `models/`:

| File | Put it in | Download |
|---|---|---|
| `qwen_image_2.1_int8_convrot.safetensors` | `ComfyUI/models/diffusion_models/` | [download](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors) |
| `qwen3vl_8b_int8_convrot.safetensors` | `ComfyUI/models/text_encoders/` | [download](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors) |
| `qwen_image_2.1_vae_bf16.safetensors` | `ComfyUI/models/vae/` | [download](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors) |

This workflow only uses nodes that ship with ComfyUI, so you don't need any extra custom nodes. If the self-check still says a file is missing after you put it in place, restart ComfyUI once.

## 3. Step 2: write services.yaml

The config file lives at:

```
~/.dsh/aha-tavern/services.yaml
```

If `DSH_HOME` is set, it lives at `$DSH_HOME/aha-tavern/services.yaml`. Create the directory and file if they don't exist.

The shortest form is just an address:

```yaml
image:
  endpoint: http://127.0.0.1:8188
```

Without this file, or without `image` / `endpoint`, image generation counts as not configured. The file is read each time it is needed, so you don't have to restart DSH after editing it; for a chat that is already running, use `/aha doctor` to make the new config take effect (see the next section).

The full form is below, with the default value for each field. You can leave out any you don't want to change:

```yaml
image:
  endpoint: http://127.0.0.1:8188   # required. ComfyUI's address
  workflow: qwen-image-2.1          # name of a built-in workflow, or the absolute path of a workflow file
  auto: true                        # true: the character decides when to draw; false: draw only when you clearly ask
  reference: true                   # true: include the character's reference sheet when drawing (see section 8); false: use the appearance text only
  style: 动漫风格插画，线条干净，光影柔和   # prepended to every scene description (default: anime-style illustration, clean lines, soft lighting)
  width: 832                        # image width, rounded down to a multiple of 32, at least 256
  height: 1216                      # image height, same rule as above
  steps: 12                         # sampling steps
  timeoutSeconds: 180               # how many seconds to wait for one image at most
  # models:                         # override the default model file names in the workflow, as needed
  #   unet: your-model.safetensors
  #   clip: your-text-encoder.safetensors
  #   vae: your-vae.safetensors
```

`examples/services.example.yaml` in the repository has the same content, and you can copy it directly.

A field with a bad value falls back to its default, and `/aha doctor` tells you which one.

## 4. Step 3: self-check

The self-check does not call any model.

**`/aha doctor`**: the receipt includes an image summary, in one of three forms:

- `生图 可用` (images available): the service is reachable and the nodes and models needed are all there.
- `生图 未配置` (images not configured): `services.yaml` was not found, or it has no `image.endpoint`.
- `生图 不可用：…` (images unavailable): followed by the first problem found, such as the service not being reachable or a missing model.

**`/aha doctor image`**: a card pops up listing the results item by item: whether the service is reachable, whether the workflow can be read, whether the required nodes are all there, and whether the model files are all there. For a missing model it says which directory under `ComfyUI/models/` it goes in, and gives a download link.

- When everything passes, the card has a "Try one image" button (试出一张图). Clicking it really generates an image, saves it to the system temp directory, and shows the path and the time taken on the card.
- If something is wrong, fix it as instructed and click "Check again" (重新检查).

For a chat that was started before the setup was done, use `/aha doctor` to make it check again; once it passes, the character can draw.

## 5. Use a GGUF quantized model

If you are short on VRAM, or want a different quantization, you can switch to the GGUF workflow.

1. Install the custom node ComfyUI-GGUF in ComfyUI (it provides the `UnetLoaderGGUF` node), then restart ComfyUI.
2. Change the workflow in `services.yaml` to `qwen-image-2.1-gguf`:

```yaml
image:
  endpoint: http://127.0.0.1:8188
  workflow: qwen-image-2.1-gguf
```

3. Get a GGUF model file for Qwen Image 2.1 yourself and put it in `ComfyUI/models/unet/`. The text encoder and VAE are the same files as for the default workflow, in the same directories (`text_encoders/`, `vae/`, see section 2).
4. The GGUF file name the workflow looks for by default is `qwen-image-2.1-UC-Q8_0.gguf`. If your file has a different name, specify it under `models`:

```yaml
image:
  endpoint: http://127.0.0.1:8188
  workflow: qwen-image-2.1-gguf
  models:
    unet: your-file-name.gguf
```

Under `models` the keys `unet`, `clip` and `vae` are recognized, and each overrides the matching model file name in the workflow. The default workflow can use file names swapped the same way.

If you use this workflow without ComfyUI-GGUF installed, `/aha doctor image` reports the missing `UnetLoaderGGUF` node.

## 6. Use your own workflow

If neither built-in workflow suits you, you can use your own.

1. Tune the workflow in ComfyUI, then export it with "Export (API)" as API-format JSON. The normal workflow save format does not work; it must be the API format.
2. Add an `_aha` field at the top level of this JSON, to tell the plugin where to fill in values and where to take the image from.
3. Save the file and point to it with an absolute path in `services.yaml`:

```yaml
image:
  endpoint: http://127.0.0.1:8188
  workflow: /Users/you/comfy/my-workflow.json
```

Fields inside `_aha`:

| Field | Required | Description |
|---|---|---|
| `slots` | Yes | The places to fill in. Each entry is written as `[node id, input name]`. |
| `slots.prompt` | Yes | Where the scene description goes. All the other slots are optional. |
| `slots.width`, `slots.height`, `slots.seed`, `slots.steps` | No | Image width, height, random seed, steps. If omitted, the values already in your workflow are used. |
| `slots.unet`, `slots.clip`, `slots.vae` | No | The three model file names. Only when given can the self-check examine them and can `models` override them. |
| `output` | Yes | The id of the node that produces the image, usually a `SaveImage` node. |
| `refs` | No | Where the reference images connect; only when given can the reference sheet be included (see section 8). Written as `{ "encoder": node id, "vae": [node id, output index], "max": max count }`: `encoder` is the text-encoding node that receives the reference images (it must have an `images` input, such as `TextEncodeQwenImage21`), `vae` is the source to connect to its `vae` input, and `max` is 1 to 16 (16 if omitted). Without `refs`, images are drawn as usual, just without the reference sheet. |
| `models` | No | Notes for the self-check: each entry has `slot` (one of `unet`, `clip`, `vae`), and optionally `dir` (which directory under `ComfyUI/models/` it goes in) and `url` (download address). When a model is missing, the self-check follows these hints. |

Node ids and input names must actually exist in the workflow, or reading it fails; `/aha doctor image` shows the reason.

A minimal example (only the nodes that are used are listed):

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "my-model.safetensors", "weight_dtype": "default" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["3", 0] } },
  "3": { "class_type": "CLIPLoader", "inputs": { "clip_name": "my-clip.safetensors", "type": "qwen_image", "device": "default" } },
  "4": { "class_type": "SaveImage", "inputs": { "images": ["5", 0], "filename_prefix": "aha" } },
  "_aha": {
    "slots": {
      "prompt": ["2", "text"],
      "unet": ["1", "unet_name"],
      "clip": ["3", "clip_name"]
    },
    "output": "4",
    "models": [
      { "slot": "unet", "dir": "diffusion_models" },
      { "slot": "clip", "dir": "text_encoders" }
    ]
  }
}
```

This only shows how to write `_aha`; it is not a complete workflow that runs as it is. For reference, look at the two built-in files in the repository's `workflows/` directory, which end with a ready-made `_aha`.

## 7. Using it in chat

Draw first, then speak: when a character wants to draw, it calls the drawing tool first, and writes the reply for that turn after the image is ready. The image shows on the first line of the reply, with the text below it. There is at most one image per turn, and generating takes a while.

**In group chat** there are two ways to draw:

- **Scene image**: draws only the setting and atmosphere. People can appear blurry, and their faces are not guaranteed.
- **Single-character close-up**: draws one character present, using their reference sheet, so the face stays consistent.

It does not draw several people together with every face consistent. When you want several people in one picture, the character switches to a scene image, or draws a close-up of each person separately. `/aha reroll` works in group chat too.

**Auto drawing**: `auto` defaults to `true`, and characters draw by themselves at moments worth keeping, such as a first meeting, a change of scene, or a turn in emotion. Small talk does not get drawn.

**Asking for an image**: just tell the character "draw one" or "draw the scene we just had".

**Reroll**:

```
/aha reroll
```

This draws the previous scene once more. To change the picture, tell the character in words, such as "change it to a snowy night, holding a red umbrella", and it rewrites the scene description and redraws. Text after the command is also passed to the character as the change request:

```
/aha reroll change it to a snowy night, holding a red umbrella
```

**Sending a message while an image is being drawn**:

- A message sent with a plain Enter is queued and handled after the whole turn (including the image) finishes.
- Send with Cmd+Enter, and the character reads it as soon as the image is ready.
- Clicking stop cancels this image, tells ComfyUI to remove the queued item and interrupt the job, and does not affect other jobs on that ComfyUI.

**If you don't want characters to draw on their own**: write `auto: false` in `services.yaml`. Characters then don't draw by themselves, and only draw when you clearly ask.

**Not configured, or the service is unreachable**: characters chat as usual, just without the ability to draw. They won't mention drawing, and there is no error. Once the service is back, run `/aha doctor` once in that chat to restore drawing.

## 8. Keep a character looking the same: the reference sheet

With only the appearance text, the face, hairstyle and clothing details of the same character change from image to image. After you make a **reference sheet** for a character, the images drawn in chat follow it.

A reference sheet is a three-view picture: the same character standing side by side seen from the front, side and back, on a light gray background. With the side and back views, there is something to go on when drawing the character from behind or in profile.

### How to make one

In a Tavern: Setup session:

```
/aha look 白狐
```

Or just tell the host "make a reference sheet for 白狐". After that it is a conversation:

1. **If you have existing images, give their paths**; if not, you don't need to. When you give images, write absolute paths or paths starting with `~/`, at most 4 at a time, PNG or JPG. Several images from different angles make the features more accurate. With no image, the host draws from the appearance on the character card.
2. The host draws a candidate, posts it, and asks "use this one, or what should change?".
3. Say what is wrong, for example "she is barefoot" or "her eyes are light purple", and the host redraws. You can change it for many rounds, and earlier candidates are kept so you can go back and pick one.
4. When you say it's good, a confirmation card pops up, and the sheet only takes effect when you click "Save".

If you gave only one image or none, the side and back views are inferred by the model, so **take a look at the back view**.

### Requirements for images you give

- Only PNG and JPG are accepted; convert other formats first.
- At most 30MB per image and 50 million pixels.
- Large images are first scaled down to 2048 pixels on the long side on your machine before uploading, so you don't need to scale them yourself.
- Images are transferred only between your computer and your own ComfyUI. If you use someone else's work as a reference, copyright is your own responsibility.
- The original images you give are not saved; only the reference sheet is kept in the character folder.

### Multiple looks

For most characters one reference sheet is enough. You can add more when needed, such as "casual clothes" or "eyes open": tell the host "add a look for 白狐 called casual clothes, worn on days off", and say clearly when this look should be used. The host takes the existing reference sheet as the base and changes only what is different.

In chat, the character decides which look to use according to the situation. Each character can have up to 8 extra looks. To delete one, tell the host.

When drawing with an extra look, the prompt does not include the appearance text from the character card (it describes the everyday look and would paint the clothes back in), so the face relies on the reference sheet alone.

### With a reference sheet

- Each image takes a few seconds longer (in our tests: about 7 seconds without, about 12 seconds with).
- Temporary changes in a scene still work, such as "puts on a raincoat" or "takes off the glasses"; just tell the character.
- To turn it off: write `reference: false` in `services.yaml`, or turn it off in the image section of the plugin's settings page.
- The report of `/aha doctor image` has two lines: whether images will be drawn with the reference sheet (with the reason if not), and whether the current character has a reference sheet and how many looks.
- The reference sheet is uploaded to ComfyUI's `input` directory as a PNG whose name starts with `aha-ref-`. The same sheet is uploaded only once, and you can delete it any time; it is re-uploaded automatically on the next image.
- When you import a character, the reference sheet and extra looks come along.

### When it is not used

In these cases images are drawn as usual, just without the reference sheet, and with no error: the character has no reference sheet yet; `reference` is off; the built-in workflow in use does not declare `refs`; the reference sheet file was deleted; the upload failed.

### Known issues

- **Distant shots with very small people** occasionally draw two or three identical people (in our tests, 2 of 12 such images). Redraw with `/aha reroll`. Half-body shots and close-ups rarely have this.
- Clothing details (ties, pockets, hem length) vary somewhat from image to image.
- The reference sheet is a three-view, and this version supports only one character in the picture.
- Photos taken vertically on a phone (JPGs that show as portrait only through an orientation tag) are treated as landscape. Rotate and re-save them in an image viewer before giving them.
- When drawing with an extra look, if this image went without the reference sheet because of an upload failure or similar, a later `/aha reroll` draws with the default look. Just tell the character again which look you want.

File locations: the reference sheet is `reference.png` in the character folder, and extra looks are under `looks/`.

## 9. Troubleshooting

**The first image is slow.** The first image has to load the model into VRAM. In our tests the first took about 1 minute and each later one about 14 seconds (832×1216, 12 steps, 24GB VRAM). Your machine will differ. If you often hit the timeout, raise `timeoutSeconds`.

**Can't connect.** First, on the machine running DSH, open the `endpoint` address in a browser and check whether you see the ComfyUI interface. If ComfyUI is on another machine, make it listen on a LAN address and make sure the firewall allows it. Then run `/aha doctor image` to see which item fails.

**Missing model or node.** `/aha doctor image` lists what is missing, and for a missing model says which directory it goes in and gives a download link. After putting it in place, click "Check again" (重新检查).

**Not enough VRAM.** Switch to the GGUF quantized model in section 5, or reduce `width` and `height`.

**The image doesn't show.** Most likely no image was drawn this turn: when the service is unavailable or drawing times out or fails, the character writes its reply as usual and doesn't mention drawing. Check with `/aha doctor image`, then redraw with `/aha reroll`. The other case is that the image was drawn but the character left the image line out of its reply. The plugin notices and has the character send it again (one extra short model call), and the resent image comes as a separate reply. The image file itself is not affected and can be found in `images/` in the chat directory.

**The same character looks different in every image.** Make a reference sheet for the character, see section 8.

**I want to turn off auto drawing.** Write `auto: false` in `services.yaml`. To turn off image generation completely, delete the `image` section or the whole file.

**Where images are stored.** In `chats/<chat directory>/images/` in the tavern folder, numbered 001, 002 and so on. The `images.jsonl` in the same directory records the scene description, seed, size and so on of each image.
