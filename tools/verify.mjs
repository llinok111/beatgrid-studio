#!/usr/bin/env node
/**
 * Browser acceptance test for the demo page.
 *
 * Runs the *built* library in real Chromium, drives the UI, and asserts on
 * observable state. Failures are reported with the assertion that broke, not
 * swallowed. Screenshots are written to shots/ (gitignored) for visual review.
 *
 * Usage: node tools/verify.mjs [baseUrl]
 */

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8899'
const shotsDir = join(root, 'shots', 'verify')
mkdirSync(shotsDir, { recursive: true })

const executablePath = join(
  process.env.LOCALAPPDATA ?? '',
  'ms-playwright',
  'chromium-1248',
  'chrome-win64',
  'chrome.exe',
)

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })

const consoleErrors = []
const pageErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => pageErrors.push(error.message))

await page.goto(`${baseUrl}/demo/index.html`, { waitUntil: 'networkidle' })

// ── 1. Page loads without script errors ──────────────────────────────────
record('页面无 JS 异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))
record('页面无 console.error', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 300))

// ── 2. Analysis completes and matches ground truth ───────────────────────
await page.waitForFunction(
  () => window.__beatgridDemo && window.__beatgridDemo.getState().bpm > 0,
  { timeout: 20000 },
)
const initial = await page.evaluate(() => window.__beatgridDemo.getState())
record(
  '首轨自动分析出 BPM',
  Math.abs(initial.bpm - initial.truth) / initial.truth <= 0.015,
  `检测 ${initial.bpm} / 真值 ${initial.truth}`,
)
record('检测到瞬态', initial.onsets > 20, `${initial.onsets} 个`)
record('网格已渲染', initial.lines > 0, `${initial.lines} 条线`)

// ── 3. Grid overlay is actually painted (not a transparent canvas) ───────
const painted = await page.evaluate(() => {
  // The waveform wrapper lives inside wavesurfer's open shadow root, so the
  // overlay canvases are NOT reachable from `document`. Query through the
  // shadow root of the renderer's host element.
  const host = document.querySelector('#waveform > div')
  const shadow = host?.shadowRoot
  const canvas = shadow?.querySelector('[part="beatgrid-lines"]')
  if (!canvas) return { ok: false, reason: 'canvas 不存在' }
  const context = canvas.getContext('2d')
  const { width, height } = canvas
  const data = context.getImageData(0, 0, width, height).data
  let nonTransparent = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 8) nonTransparent++
  }
  return { ok: nonTransparent > 200, count: nonTransparent, width, height }
})
record('网格层有实际像素输出', painted.ok, `${painted.count ?? 0} 个不透明像素 / ${painted.width}x${painted.height}`)

// ── 4. All four tracks analyse correctly ─────────────────────────────────
const trackNames = await page.$$eval('.track', (nodes) => nodes.map((n) => n.dataset.file))
for (const file of trackNames) {
  await page.click(`.track[data-file="${file}"]`)
  await page.waitForFunction(
    (expected) => {
      const state = window.__beatgridDemo?.getState()
      return state && state.bpm > 0 && Math.abs(state.bpm - expected) / expected <= 0.02
    },
    Number(file.match(/(\d+)\.wav/)[1]),
    { timeout: 20000 },
  )
  const state = await page.evaluate(() => window.__beatgridDemo.getState())
  record(
    `${file} 分析正确`,
    Math.abs(state.bpm - state.truth) / state.truth <= 0.02,
    `${state.bpm} vs ${state.truth}（误差 ${((Math.abs(state.bpm - state.truth) / state.truth) * 100).toFixed(2)}%）`,
  )
}

// Back to the 120 BPM track for the interaction checks.
await page.click('.track[data-file="groove-120.wav"]')
await page.waitForFunction(() => window.__beatgridDemo.getState().bpm > 0, { timeout: 20000 })

// ── 5. BPM slider drives the grid ────────────────────────────────────────
await page.evaluate(() => window.__beatgridDemo.setBpm(140))
const afterBpm = await page.evaluate(() => window.__beatgridDemo.getState())
record('BPM 手动设置生效', Math.abs(afterBpm.bpm - 140) < 0.01, `${afterBpm.bpm}`)
record(
  'BPM 变化后拍间隔同步',
  Math.abs(afterBpm.beatInterval - 60 / 140) < 0.001,
  `${afterBpm.beatInterval.toFixed(4)} s`,
)

// ── 6. Looping ───────────────────────────────────────────────────────────
await page.click('#loop-bar')
const looping = await page.evaluate(() => window.__beatgridDemo.getState())
record('循环已启用', looping.looping === true)
const loopStatus = await page.textContent('#loop-status')
record('循环状态文案更新', /循环/.test(loopStatus ?? ''), loopStatus ?? '')

await page.click('#loop-clear')
const cleared = await page.evaluate(() => window.__beatgridDemo.getState())
record('循环可取消', cleared.looping === false)

// ── 7. Playback actually advances ────────────────────────────────────────
await page.evaluate(() => window.__beatgridDemo.play())
await page.waitForTimeout(700)
const playState = await page.evaluate(() => window.__beatgridDemo.getState())
record('播放启动', playState.playing === true)
await page.evaluate(() => window.__beatgridDemo.pause())

// ── 8. Toggles hide/show the grid ────────────────────────────────────────
await page.uncheck('#show-grid')
await page.waitForTimeout(150)
const hiddenPixels = await page.evaluate(() => {
  const shadow = document.querySelector('#waveform > div')?.shadowRoot
  const canvas = shadow?.querySelector('[part="beatgrid-lines"]')
  if (!canvas) return -1
  const context = canvas.getContext('2d')
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  let count = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) count++
  return count
})
record('关闭网格后画布清空', hiddenPixels < 50, `${hiddenPixels} 个不透明像素`)
await page.check('#show-grid')
await page.waitForTimeout(150)

// ── 9. Screenshots at three breakpoints ──────────────────────────────────
const breakpoints = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet', width: 1024, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

for (const bp of breakpoints) {
  await page.setViewportSize({ width: bp.width, height: bp.height })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(shotsDir, `demo-${bp.name}.png`), fullPage: false })

  // Horizontal overflow is the classic responsive failure: assert on the
  // document width, not on a guess about which element is too wide.
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  record(
    `${bp.name} 无横向溢出`,
    overflow.scrollWidth <= overflow.clientWidth + 1,
    `${overflow.scrollWidth} / ${overflow.clientWidth}`,
  )
}

// ── 9b. Layout sanity: panels sized, no overlap, readable type ───────────
const layout = await page.evaluate(() => {
  const rect = (sel) => {
    const node = document.querySelector(sel)
    if (!node) return null
    const r = node.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) }
  }
  const panels = ['.panel--tracks', '.panel--stage', '.panel--controls'].map(rect)
  const wave = rect('.stage__wave')
  const body = getComputedStyle(document.body)
  const h1 = document.querySelector('.masthead h1')
  return {
    panels,
    wave,
    fontSize: body.fontSize,
    h1Size: h1 ? getComputedStyle(h1).fontSize : null,
    // A panel narrower than 200 px or shorter than 120 px is collapsed.
    minPanelWidth: Math.min(...panels.filter(Boolean).map((p) => p.w)),
    minPanelHeight: Math.min(...panels.filter(Boolean).map((p) => p.h)),
  }
})
record(
  '三栏面板均有实际尺寸',
  layout.minPanelWidth > 200 && layout.minPanelHeight > 120,
  `最小 ${layout.minPanelWidth}x${layout.minPanelHeight}`,
)
record('波形区高度足够', (layout.wave?.h ?? 0) >= 180, `${layout.wave?.h} px`)
record('正文基准字号可读', parseFloat(layout.fontSize) >= 14, layout.fontSize)

// ── 9c. Visual structure: sample the canvas, don't guess ─────────────────
// Restore the desktop viewport first: the breakpoint loop above ends on the
// 390 px mobile size, where beat lines are intentionally dropped for density,
// so sampling there would report a "missing tier" that is in fact correct
// behaviour.
await page.setViewportSize({ width: 1440, height: 1000 })
await page.waitForTimeout(300)

//
// This is not a screenshot diff. It samples the grid canvas column by column
// and asserts that the three-tier hierarchy actually exists in the pixels:
// bar lines span the full height, beat lines about half, subdivisions about a
// fifth. A regression that flattened the hierarchy (or stopped drawing a tier)
// would fail here even if the line count stayed the same.
const tiers = await page.evaluate(() => {
  const shadow = document.querySelector('#waveform > div')?.shadowRoot
  const canvas = shadow?.querySelector('[part="beatgrid-lines"]')
  if (!canvas) return null
  const context = canvas.getContext('2d')
  const { width, height } = canvas
  const data = context.getImageData(0, 0, width, height).data
  const coverage = []
  for (let x = 0; x < width; x++) {
    let painted = 0
    let peakAlpha = 0
    for (let y = 0; y < height; y++) {
      const alpha = data[(y * width + x) * 4 + 3]
      if (alpha > 8) painted++
      if (alpha > peakAlpha) peakAlpha = alpha
    }
    if (painted > 0) coverage.push({ x, ratio: painted / height, peakAlpha })
  }
  const near = (value, target, tol) => Math.abs(value - target) <= tol
  return {
    columns: coverage.length,
    fullHeight: coverage.filter((c) => near(c.ratio, 1, 0.06)).length,
    halfHeight: coverage.filter((c) => near(c.ratio, 0.5, 0.08)).length,
    bottomOnly: coverage.filter((c) => c.ratio <= 0.28).length,
    maxAlpha: Math.max(...coverage.map((c) => c.peakAlpha)),
  }
})

record('画布上存在全高小节线', (tiers?.fullHeight ?? 0) >= 2, `${tiers?.fullHeight} 列`)
record('画布上存在半高拍线', (tiers?.halfHeight ?? 0) >= 4, `${tiers?.halfHeight} 列`)
record('画布上存在底部细分/瞬态短线', (tiers?.bottomOnly ?? 0) >= 4, `${tiers?.bottomOnly} 列`)
record('小节线比细分线更醒目', (tiers?.maxAlpha ?? 0) >= 150, `峰值 alpha ${tiers?.maxAlpha}`)

// ── 10. Performance: measured, not estimated ─────────────────────────────
//
// Three separate numbers, because they answer different questions:
//   - redraw:  synchronous cost of one grid repaint (setBpm -> effect -> draw)
//   - analysis: full STFT + tempo search over the decoded buffer
//   - frames:  rAF interval distribution during playback (pacing, not redraw)
await page.setViewportSize({ width: 1440, height: 1000 })

const perf = await page.evaluate(async () => {
  const state = window.__beatgridDemo

  // (a) Synchronous repaint cost. setBpm writes the grid signal, which runs
  // the plugin's effect and repaints the canvas synchronously, so the delta is
  // the actual draw cost — no rAF waiting involved.
  const redraw = []
  for (let i = 0; i < 12; i++) {
    const started = performance.now()
    state.setBpm(96 + i * 4)
    redraw.push(performance.now() - started)
  }

  // (b) Analysis cost for the whole decoded track.
  const analysis = []
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    state.analyze()
    analysis.push(performance.now() - started)
  }

  // (c) Frame pacing during playback: intervals between animation frames.
  state.play()
  const frames = await new Promise((resolve) => {
    const deltas = []
    let previous = 0
    const tick = (time) => {
      if (previous) deltas.push(time - previous)
      previous = time
      if (deltas.length < 90) requestAnimationFrame(tick)
      else resolve(deltas)
    }
    requestAnimationFrame(tick)
  })
  state.pause()

  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    return {
      mean,
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      max: sorted[sorted.length - 1],
    }
  }

  return {
    redraw: stats(redraw),
    analysis: stats(analysis),
    frames: stats(frames),
    duration: 30,
  }
})

record(
  '单次网格重绘 < 8 ms',
  perf.redraw.p95 < 8,
  `均值 ${perf.redraw.mean.toFixed(2)} / p95 ${perf.redraw.p95.toFixed(2)} / 最大 ${perf.redraw.max.toFixed(2)} ms`,
)
record(
  '整轨分析 < 1000 ms',
  perf.analysis.p95 < 1000,
  `均值 ${perf.analysis.mean.toFixed(0)} / p95 ${perf.analysis.p95.toFixed(0)} ms`,
)
record(
  '播放帧间隔 p95 < 34 ms（≥30fps）',
  perf.frames.p95 < 34,
  `均值 ${perf.frames.mean.toFixed(1)} / p95 ${perf.frames.p95.toFixed(1)} / 最大 ${perf.frames.max.toFixed(1)} ms`,
)

console.log('')
console.log('性能明细（本机实测，headless Chromium 156）:')
console.log(`  重绘   mean ${perf.redraw.mean.toFixed(2)} ms  p95 ${perf.redraw.p95.toFixed(2)} ms  max ${perf.redraw.max.toFixed(2)} ms`)
console.log(`  分析   mean ${perf.analysis.mean.toFixed(0)} ms  p95 ${perf.analysis.p95.toFixed(0)} ms（约 ${perf.duration}s 音频）`)
console.log(`  帧间隔 mean ${perf.frames.mean.toFixed(1)} ms  p95 ${perf.frames.p95.toFixed(1)} ms  max ${perf.frames.max.toFixed(1)} ms`)

await browser.close()

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(` - ${f.name} ${f.detail}`)
  process.exit(1)
}
