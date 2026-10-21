# BeatGrid Studio

**wavesurfer.js 的节拍感知编辑层** — 自动 BPM 检测、相位对齐节拍网格、吸附、按小节循环。

基于 [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) v8.0.3 二次开发。
上游是波形渲染与播放库，**没有任何音乐时间概念**：没有 BPM、没有节拍网格、没有吸附、没有按小节循环。
本项目在不修改上游任何既有文件行为的前提下，补上这一层。

---

## 它解决什么

| 能力 | 上游 wavesurfer.js v8 | 本项目 |
|---|---|---|
| 波形渲染 / 播放 / 缩放 / 滚动 | ✅ | 沿用（未改动） |
| 区域（regions）拖拽与缩放 | ✅ | 沿用，并可选择吸附到节拍 |
| BPM 检测 | ❌ | ✅ STFT 谱通量 + 梳状评分 |
| 瞬态（onset）检测 | ❌ | ✅ 自适应阈值峰值拾取 |
| 节拍网格叠加层 | ❌ | ✅ 小节 / 拍 / 细分三级层级 |
| 吸附（时间与区间量化） | ❌ | ✅ `snapTime` / `snapRange` |
| 按小节循环 | ❌ | ✅ 无缝循环 + 播放头回绕 |
| 打拍定速（tap tempo） | ❌ | ✅ 最近 8 次取平均 |

> 关于「多轨」：上游已于 2023 年把多轨功能拆到独立仓库
> [wavesurfer-multitrack](https://github.com/katspaugh/wavesurfer-multitrack)（44★）。
> 本项目**不重做多轨**，专注补上缺失的节拍层。

---

## 快速开始

```bash
# 1. 安装依赖（上游用 yarn.lock；npm 需要 --legacy-peer-deps 绕过 cypress 的 peer 冲突）
npm install --legacy-peer-deps

# 2. 构建库产物（tsc + rollup + 导出校验）
npm run build

# 3. 生成演示音频（程序化合成，无第三方素材）
node scripts/make-demo-audio.mjs

# 4. 起一个静态服务，然后打开 /demo/index.html
python -m http.server 8899 --bind 127.0.0.1
# → http://127.0.0.1:8899/demo/index.html
```

演示页依赖 `dist/` 产物，所以必须先 `npm run build`。

### 在你自己项目里使用

```js
import WaveSurfer from 'wavesurfer.js'
import BeatGridPlugin from 'wavesurfer.js/plugins/beatgrid'

const beatgrid = BeatGridPlugin.create({
  beatsPerBar: 4,
  subdivisions: 2,
  snapRegions: true,   // 区域拖拽结束后吸附到拍
  showOnsets: true,
})

const wavesurfer = WaveSurfer.create({
  container: '#waveform',
  url: 'track.mp3',
  plugins: [beatgrid],
})

// 音频解码完成后自动分析
beatgrid.on('grid-ready', (grid) => {
  console.log(grid.bpm, grid.offset, grid.confidence)
})

// 循环第 3 小节
beatgrid.loopBarAt(6.0)
```

> 注意：插件事件在**插件实例**上触发，不会转发到 `wavesurfer` 实例
> （上游 `registerPlugin()` 只调用 `plugin._init()`）。监听请写成
> `beatgrid.on('grid-ready', ...)`，而不是 `wavesurfer.on('grid-ready', ...)`。

---

## API

### 选项

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `beatsPerBar` | `number` | `4` | 每小节拍数，用于区分小节线与拍线 |
| `subdivisions` | `1 \| 2 \| 4` | `2` | 细分线密度；过密时自动降级 |
| `showGrid` | `boolean` | `true` | 是否显示网格 |
| `showOnsets` | `boolean` | `true` | 是否显示检测到的瞬态 |
| `barColor` / `beatColor` / `subdivisionColor` | `string` | 琥珀色系 | 三级线条颜色 |
| `snapRegions` | `boolean` | `false` | 区域拖拽后吸附（opt-in） |
| `snapThreshold` | `number` | `0.5` | 吸附阈值，单位为拍 |
| `analysis` | `AnalyzeOptions` | — | 分析参数（见下） |

### 方法

```ts
analyze(): BeatGrid                 // 重新分析
getGrid(): BeatGrid                 // 当前网格快照
setBpm(bpm: number): BeatGrid       // 手动设定，钳制在 20..400
nudge(beats: number): BeatGrid      // 相位微调（可为小数拍）
setOffset(seconds: number): BeatGrid
setBeatsPerBar(beats: number): BeatGrid
getOnsets(): Onset[]                // 检测到的瞬态
snapTime(time: number): number
snapRange(start: number, end: number): { start: number; end: number }
setVisible(v: boolean): void
setOnsetsVisible(v: boolean): void
tap(): number                       // 返回当前 tap-tempo 估计（0 = 尚未够两次）
resetTap(): void
setLoop(range: { start, end } | null): void
loopBarAt(time?: number): void
isLooping(): boolean
barStartAt(time: number): number    // 已钳制为非负
barIndexAt(time: number): number
getRenderedLineCount(): number      // 当前实际绘制的线条数（诊断用）
```

### 事件

`grid-ready` · `grid-change` · `onsets-ready` · `loop-change` · `tap-tempo` · `destroy`

### 分析参数（`AnalyzeOptions`）

| 参数 | 默认 | 说明 |
|---|---|---|
| `fftSize` | `1024` | 必须是 2 的幂且 ≥ 32 |
| `hopSize` | `fftSize / 4` | 帧移 |
| `minBpm` / `maxBpm` | `60` / `200` | 搜索范围 |
| `sensitivity` | `0.5` | 0 = 只抓强瞬态，1 = 宽松 |
| `minOnsetGap` | `0.05` | 最小瞬态间隔（秒） |

---

## 算法

```
PCM ──► 分帧 → Hann 窗 → FFT → 幅度谱
           │
           ├─► 对数压缩谱通量 ──► 自适应阈值 ──► 瞬态列表（供吸附与可视化）
           │
           └─► 瞬态强度包络 ──► 候选 BPM 扫描
                                    └─► 梳状能量 × 齿能量均匀性² × 齿覆盖率
                                            └─► 相位拟合（1 ms 扫描）
```

三项乘积的每一项都是因为更简单的方案实测失败才引入的，详见 [`TECHNICAL.md`](./TECHNICAL.md)。

---

## 测试

```bash
npm run test:unit            # 全部单元测试（含上游 920 项）
npm run test:unit -- src/__tests__/beat-analysis.test.ts   # 只跑新增分析测试
node tools/verify.mjs        # 浏览器验收（需先起服务，见上）
```

最近一次执行结果见 [`TEST-REPORT.md`](./TEST-REPORT.md)。

---

## 目录结构

```
src/beat-analysis.ts          新增：DSP 与节拍估计（纯函数，无 DOM 依赖）
src/plugins/beatgrid.ts       新增：网格插件（overlay / 吸附 / 循环 / tap）
src/__tests__/beat-analysis.test.ts   新增：合成信号真值测试
src/__tests__/beatgrid.test.ts        新增：插件 DOM 与交互测试
src/__tests__/demo-audio.test.ts      新增：真实鼓点精度测试
demo/                         新增：交互演示页
scripts/make-demo-audio.mjs   新增：程序化生成演示音频
tools/verify.mjs              新增：Chromium 验收脚本
```

上游文件仅两处非行为性修改（均为 Windows 可移植性修复），见 `NOTICE`。

---

## 许可证

BSD-3-Clause，与上游一致。上游版权归 katspaugh and contributors（2012-2023）。
新增部分版权声明见 [`NOTICE`](./NOTICE)。

演示音频由 `scripts/make-demo-audio.mjs` 程序化合成，以 CC0-1.0 释出，不含任何第三方素材。
