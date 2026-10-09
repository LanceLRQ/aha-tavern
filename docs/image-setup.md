# 配置生图

这份说明带你从一台刚装好的 ComfyUI 开始，配到能在聊天里出图。按顺序做就行。

阿哈酒馆不自带生图模型，只负责把剧情里的画面交给你自己的 ComfyUI。出图期间不会调用别的模型，图片只存在你的酒馆文件夹里。

## 1. 你需要什么

- 一个能用的 ComfyUI。我们实测用的是 0.38.0。
- 一块显存够用的显卡。实测环境是 24GB 显存，出图后显存常驻约 15.5GB。显存更小的话，看下面的"用 GGUF 量化模型"一节。
- ComfyUI 不一定要和 DSH 在同一台机器上，只要 DSH 所在的机器能用 HTTP 连上它的地址（比如 `http://127.0.0.1:8188`）。
- 地址里不要带用户名和密码。

## 2. 第一步：放模型文件

默认工作流 `qwen-image-2.1` 要三个模型文件。下载后放进 ComfyUI 的 `models/` 下对应的目录：

| 文件 | 放到 | 下载地址 |
|---|---|---|
| `qwen_image_2.1_int8_convrot.safetensors` | `ComfyUI/models/diffusion_models/` | [下载](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors) |
| `qwen3vl_8b_int8_convrot.safetensors` | `ComfyUI/models/text_encoders/` | [下载](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors) |
| `qwen_image_2.1_vae_bf16.safetensors` | `ComfyUI/models/vae/` | [下载](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors) |

这个工作流只用 ComfyUI 自带的节点，不用装额外的自定义节点。放好后如果自检还说缺这个文件，重启一次 ComfyUI。

## 3. 第二步：写 services.yaml

配置文件放在：

```
~/.dsh/aha-tavern/services.yaml
```

设了 `DSH_HOME` 时放在 `$DSH_HOME/aha-tavern/services.yaml`。目录和文件不存在就自己建。

最短的写法，只有一个地址：

```yaml
image:
  endpoint: http://127.0.0.1:8188
```

没有这个文件，或者没有 `image` / `endpoint`，就等于没配置生图。每次用到时才读取，改完不用重启 DSH；已经在聊的会话要用 `/aha 自检` 让新配置生效（见下一节）。

完整的写法，下面每个字段都写了默认值，不想改的可以不写：

```yaml
image:
  endpoint: http://127.0.0.1:8188   # 必填。ComfyUI 的地址
  workflow: qwen-image-2.1          # 内置工作流名，或工作流文件的绝对路径
  auto: true                        # true：角色自己判断什么时候画；false：只在你明说要画时才画
  style: 动漫风格插画，线条干净，光影柔和   # 拼在每次画面描述的最前面
  width: 832                        # 图宽，向下取到 32 的倍数，不小于 256
  height: 1216                      # 图高，规则同上
  steps: 12                         # 采样步数
  timeoutSeconds: 180               # 单张出图最多等多少秒
  # models:                         # 覆盖工作流里默认的模型文件名，按需填写
  #   unet: your-model.safetensors
  #   clip: your-text-encoder.safetensors
  #   vae: your-vae.safetensors
```

仓库里的 `examples/services.example.yaml` 是同样内容，可以直接复制。

写错的字段会改用默认值，并在 `/aha 自检` 里提示是哪一项。

## 4. 第三步：自检

自检不会调用模型。

**`/aha 自检`**：回执里有一段生图小结，有三种：

- `生图 可用`：服务连得上，需要的节点和模型都在。
- `生图 未配置`：没找到 `services.yaml`，或里面没有 `image.endpoint`。
- `生图 不可用：…`：后面写了第一个问题，比如连不上服务、缺模型。

**`/aha 自检 生图`**：弹出一张卡片，逐项列出结果：服务能不能连上、工作流读不读得了、需要的节点齐不齐、模型文件齐不齐。缺模型时会写明要放到 `ComfyUI/models/` 下哪个目录，并给出下载链接。

- 全部通过时，卡片上有"试出一张图"。点了会真的生成一张，存到系统临时目录，卡片上写路径和用时。
- 有问题时，按提示改好，再点"重新检查"。

配好之前就已经开始聊的会话，也用 `/aha 自检` 让它重新检查，通过后角色就能画图了。

## 5. 用 GGUF 量化模型

显存不够，或者想用别的量化版本时，可以换成 GGUF 工作流。

1. 给 ComfyUI 装自定义节点 ComfyUI-GGUF（它提供 `UnetLoaderGGUF` 节点），装完重启 ComfyUI。
2. 把 `services.yaml` 里的工作流改成 `qwen-image-2.1-gguf`：

```yaml
image:
  endpoint: http://127.0.0.1:8188
  workflow: qwen-image-2.1-gguf
```

3. 自备一个 Qwen Image 2.1 的 GGUF 模型文件，放进 `ComfyUI/models/unet/`。文本编码器和 VAE 与默认工作流用同一份，目录也一样（`text_encoders/`、`vae/`，见第 2 节）。
4. 工作流默认找的 GGUF 文件名是 `qwen-image-2.1-UC-Q8_0.gguf`。你的文件叫别的名字，就在 `models` 里指定：

```yaml
image:
  endpoint: http://127.0.0.1:8188
  workflow: qwen-image-2.1-gguf
  models:
    unet: 你的文件名.gguf
```

`models` 下面认 `unet`、`clip`、`vae` 三个键，分别覆盖工作流里对应的模型文件名。默认工作流同样可以这样换文件名。

没装 ComfyUI-GGUF 就用了这个工作流，`/aha 自检 生图` 会提示缺少 `UnetLoaderGGUF` 节点。

## 6. 用自己的工作流

内置的两个工作流不合你意时，可以用自己的。

1. 在 ComfyUI 里调好工作流，用"导出（API）"导出成 API 格式的 JSON。普通的工作流保存格式不行，必须是 API 格式。
2. 在这个 JSON 的最顶层加一个 `_aha` 字段，告诉插件往哪里填值、从哪里取图。
3. 把文件存好，在 `services.yaml` 里用绝对路径指向它：

```yaml
image:
  endpoint: http://127.0.0.1:8188
  workflow: /Users/你/comfy/my-workflow.json
```

`_aha` 里的字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `slots` | 是 | 要填值的位置。每一项写成 `[节点编号, 输入名]`。 |
| `slots.prompt` | 是 | 画面描述填到哪。其余位置都可以不写。 |
| `slots.width`、`slots.height`、`slots.seed`、`slots.steps` | 否 | 图宽、图高、随机种子、步数。不写就用你工作流里原有的值。 |
| `slots.unet`、`slots.clip`、`slots.vae` | 否 | 三个模型文件名。写了才能被自检检查，也才能被 `models` 覆盖。 |
| `output` | 是 | 产出图片的节点编号，一般是 `SaveImage` 节点。 |
| `models` | 否 | 给自检用的说明：每项写 `slot`（`unet`、`clip`、`vae` 之一），可选 `dir`（放在 `ComfyUI/models/` 下的哪个目录）和 `url`（下载地址）。缺模型时自检会照这个提示。 |

节点编号和输入名要真实存在于工作流里，不然读取时会报错，`/aha 自检 生图` 里能看到原因。

一个最小的例子（节点只列出了会被用到的部分）：

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

上面只是演示 `_aha` 的写法，不是能直接跑通的完整工作流。可以参考仓库 `workflows/` 目录里的两个内置文件，它们末尾就是写好的 `_aha`。

## 7. 聊天时怎么用

先画后说：角色要画图时，会先调用画图工具，图出来之后再写这一轮的回复，图片显示在回复的末尾。每轮最多一张，出图要等一会儿。

**自动出图**：`auto` 默认是 `true`，角色会在值得留下的时刻自己画，比如初次见面、换了场景、情绪有转折。闲聊不会画。

**主动要图**：直接跟角色说"画一张""把刚才那一幕画出来"就行。

**重新生图**：

```
/aha 重新生图
```

按原来的画面再画一张。想改画面，直接用话告诉角色，比如"换成雪夜，撑一把红伞"，角色会改写画面描述后重画。命令后面带的文字也会作为修改要求交给角色：

```
/aha 重新生图 换成雪夜，撑一把红伞
```

**出图时插话**：

- 直接回车发出的消息会排队，等这一整轮（包括出图）结束后才处理。
- 用 Cmd+Enter 发送，图出来后角色马上就能读到。
- 点停止会取消这次出图，并通知 ComfyUI 把排队项撤掉、中断这个任务，不影响这台 ComfyUI 上别的任务。

**不想让角色自己画**：在 `services.yaml` 里写 `auto: false`。角色就不会主动画，只在你明说要画时才画。

**没配置或服务连不上**：角色照常聊天，只是没有画图能力，不会提画图，也不会报错。服务恢复后，在该会话里跑一次 `/aha 自检` 就能恢复画图。

## 8. 常见问题

**第一张图很慢。** 第一张要把模型加载进显存。我们的实测是第一张约 1 分钟，之后每张约 14 秒（832×1216、12 步、24GB 显存）。你的机器会不一样。如果经常超时，把 `timeoutSeconds` 调大。

**连不上。** 先在 DSH 所在的机器上，用浏览器打开 `endpoint` 里的地址，看能不能看到 ComfyUI 界面。ComfyUI 在另一台机器上时，要让它监听局域网地址，并确认防火墙放行。然后跑 `/aha 自检 生图` 看具体哪一项不通过。

**缺模型或缺节点。** `/aha 自检 生图` 会列出缺的东西，缺模型时写明放哪个目录并给下载链接。放好后点"重新检查"。

**显存不够。** 换成第 5 节的 GGUF 量化模型，或者调小 `width` 和 `height`。

**图不显示。** 多半是这一轮没出图：服务不可用、出图超时或失败时，角色会照常写回复，不会提起画图。用 `/aha 自检 生图` 查一下，再用 `/aha 重新生图` 重画。另一种情况是图画出来了，但角色的回复里漏了图片那一行。插件发现后会让角色补发一次（多一次很短的模型调用），补出来的图片单独成一条回复。图片文件本身不受影响，在聊天目录的 `images/` 里都能找到。

**想关掉自动画图。** 在 `services.yaml` 里写 `auto: false`。想彻底不要生图，删掉 `image` 这一节或整个文件。

**图片存在哪。** 存在酒馆文件夹里这次聊天目录下的 `chats/<聊天目录>/images/`，按 001、002……编号。同一目录下的 `images.jsonl` 记录每张图的画面描述、种子、尺寸等。
