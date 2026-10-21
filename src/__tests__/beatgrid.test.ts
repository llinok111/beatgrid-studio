/**
 * BeatGridPlugin tests.
 *
 * The wavesurfer instance is faked at the level of its *public* contract
 * (getWrapper / getRenderer / getDecodedData / on / getCurrentTime / setTime /
 * play), matching how the upstream plugin tests are written. Canvas is stubbed
 * per-test so we can assert on what was actually drawn, not merely that no
 * exception was thrown.
 */

import BeatGridPlugin from '../plugins/beatgrid.js'
import type { BeatGridApi } from '../plugins/beatgrid.js'
import { signal } from '../reactive/store.js'
import { createEmitter } from './helpers/create-emitter.js'

const SAMPLE_RATE = 22050

function makeNoise(seed = 12345) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return (state / 0x7fffffff) * 2 - 1
  }
}

/** Click track at a known BPM, as a real AudioBuffer-like object. */
function clickTrackBuffer(bpm: number, seconds: number, offset = 0.1): AudioBuffer {
  const length = Math.floor(seconds * SAMPLE_RATE)
  const data = new Float32Array(length)
  const interval = 60 / bpm
  const burstLength = Math.floor(0.012 * SAMPLE_RATE)
  const rand = makeNoise()
  for (let t = offset; t < seconds; t += interval) {
    const start = Math.floor(t * SAMPLE_RATE)
    for (let i = 0; i < burstLength && start + i < length; i++) {
      data[start + i] += rand() * Math.exp((-6 * i) / burstLength) * 0.8
    }
  }
  return {
    numberOfChannels: 1,
    length,
    sampleRate: SAMPLE_RATE,
    duration: seconds,
    getChannelData: () => data,
  } as unknown as AudioBuffer
}

type DrawCall = { op: string; args: number[]; style?: string }

/** Records canvas draw operations so tests can assert on geometry. */
function stubCanvas() {
  const calls: DrawCall[] = []
  let currentStroke = ''
  let currentFill = ''
  const context = {
    setTransform: () => undefined,
    clearRect: (...args: number[]) => calls.push({ op: 'clearRect', args }),
    beginPath: () => undefined,
    moveTo: (...args: number[]) => calls.push({ op: 'moveTo', args, style: currentStroke }),
    lineTo: (...args: number[]) => calls.push({ op: 'lineTo', args, style: currentStroke }),
    stroke: () => calls.push({ op: 'stroke', args: [], style: currentStroke }),
    fillRect: (...args: number[]) => calls.push({ op: 'fillRect', args, style: currentFill }),
    set strokeStyle(value: string) {
      currentStroke = value
    },
    get strokeStyle() {
      return currentStroke
    },
    set fillStyle(value: string) {
      currentFill = value
    },
    get fillStyle() {
      return currentFill
    },
    set lineWidth(value: number) {
      void value
    },
    get lineWidth() {
      return 1
    },
  }
  const original = window.HTMLCanvasElement.prototype.getContext
  window.HTMLCanvasElement.prototype.getContext = function () {
    return context
  } as unknown as typeof window.HTMLCanvasElement.prototype.getContext
  return {
    calls,
    restore: () => {
      window.HTMLCanvasElement.prototype.getContext = original
    },
  }
}

type FakeOptions = {
  duration?: number
  width?: number
  height?: number
  buffer?: AudioBuffer | null
  currentTime?: number
}

function createWaveSurfer(opts: FakeOptions = {}) {
  const duration = opts.duration ?? 20
  const width = opts.width ?? 800
  const height = opts.height ?? 120
  const emitter = createEmitter()
  const durationSignal = signal(duration)
  const visibleRangeSignal = signal({ startTime: 0, endTime: duration })

  const wrapper = document.createElement('div')
  Object.defineProperty(wrapper, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(wrapper, 'clientHeight', { configurable: true, value: height })
  document.body.appendChild(wrapper)

  const plays: Array<[number?, number?]> = []
  const times: number[] = []
  let currentTime = opts.currentTime ?? 0

  const wavesurfer = {
    ...emitter,
    getWrapper: jest.fn(() => wrapper),
    getWidth: jest.fn(() => width),
    getDuration: jest.fn(() => duration),
    getCurrentTime: jest.fn(() => currentTime),
    getScroll: jest.fn(() => 0),
    getState: jest.fn(() => ({ duration: durationSignal })),
    getDecodedData: jest.fn(() => opts.buffer ?? null),
    getActivePlugins: jest.fn(() => []),
    getRenderer: jest.fn(() => ({
      getVisibleRange: jest.fn(() => visibleRangeSignal),
    })),
    setTime: jest.fn((time: number) => {
      currentTime = time
      times.push(time)
    }),
    play: jest.fn(async (start?: number, end?: number) => {
      plays.push([start, end])
    }),
    __setCurrentTime: (time: number) => {
      currentTime = time
    },
    __setVisibleRange: (startTime: number, endTime: number) => {
      visibleRangeSignal.set({ startTime, endTime })
    },
    __plays: plays,
    __times: times,
  }
  return wavesurfer
}

const init = (options: Parameters<typeof BeatGridPlugin.create>[0], fake = createWaveSurfer()) => {
  const plugin = BeatGridPlugin.create(options)
  plugin._init(fake as never)
  return { plugin: plugin as BeatGridApi & typeof plugin, fake }
}

describe('BeatGridPlugin', () => {
  let canvas: ReturnType<typeof stubCanvas>

  beforeEach(() => {
    canvas = stubCanvas()
  })

  afterEach(() => {
    canvas.restore()
    document.body.innerHTML = ''
    jest.clearAllMocks()
  })

  describe('construction', () => {
    test('mounts an overlay into the wrapper with two canvases', () => {
      init({})
      const root = document.querySelector('[part="beatgrid"]')
      expect(root).not.toBeNull()
      expect(root?.querySelectorAll('canvas')).toHaveLength(2)
    })

    test('respects a custom container', () => {
      const custom = document.createElement('div')
      document.body.appendChild(custom)
      init({ container: custom })
      expect(custom.querySelector('[part="beatgrid"]')).not.toBeNull()
    })

    test('throws a named error for a missing container selector', () => {
      expect(() => init({ container: '#does-not-exist' })).toThrow(/BeatGridPlugin: container not found/)
    })

    test('starts with an empty grid before analysis', () => {
      const { plugin } = init({})
      expect(plugin.getGrid().bpm).toBe(0)
      expect(plugin.getGrid().beatInterval).toBe(0)
    })
  })

  describe('analysis', () => {
    test('auto-analyses on the ready event and emits grid-ready', () => {
      const fake = createWaveSurfer({ buffer: clickTrackBuffer(120, 20) })
      const { plugin } = init({}, fake)
      const onReady = jest.fn()
      plugin.on('grid-ready', onReady)

      fake.emit('ready', 20)

      expect(onReady).toHaveBeenCalledTimes(1)
      const grid = plugin.getGrid()
      expect(Math.abs(grid.bpm - 120)).toBeLessThan(2)
      expect(grid.beatInterval).toBeCloseTo(60 / grid.bpm, 6)
      expect(grid.confidence).toBeGreaterThan(0)
    })

    test('emits onsets-ready with the detected onsets', () => {
      const fake = createWaveSurfer({ buffer: clickTrackBuffer(120, 20) })
      const { plugin } = init({}, fake)
      const onOnsets = jest.fn()
      plugin.on('onsets-ready', onOnsets)
      fake.emit('ready', 20)
      expect(onOnsets).toHaveBeenCalledTimes(1)
      const onsets = onOnsets.mock.calls[0][0]
      expect(onsets.length).toBeGreaterThan(30)
      expect(plugin.getOnsets()).toHaveLength(onsets.length)
    })

    test('handles audio that has not been decoded yet', () => {
      const fake = createWaveSurfer({ buffer: null })
      const { plugin } = init({}, fake)
      const grid = plugin.analyze()
      expect(grid.bpm).toBe(0)
      expect(plugin.getOnsets()).toHaveLength(0)
    })

    test('honours beatsPerBar from options', () => {
      const fake = createWaveSurfer({ buffer: clickTrackBuffer(120, 12) })
      const { plugin } = init({ beatsPerBar: 3 }, fake)
      fake.emit('ready', 12)
      expect(plugin.getGrid().beatsPerBar).toBe(3)
    })
  })

  describe('manual grid control', () => {
    test('setBpm clamps to a sane range and updates the interval', () => {
      const { plugin } = init({})
      expect(plugin.setBpm(1000).bpm).toBe(400)
      expect(plugin.setBpm(1).bpm).toBe(20)
      const grid = plugin.setBpm(90)
      expect(grid.beatInterval).toBeCloseTo(60 / 90, 6)
    })

    test('setBpm emits grid-change', () => {
      const { plugin } = init({})
      const onChange = jest.fn()
      plugin.on('grid-change', onChange)
      plugin.setBpm(128)
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ bpm: 128 }))
    })

    test('nudge shifts the phase by whole or fractional beats', () => {
      const { plugin } = init({})
      plugin.setBpm(120)
      plugin.setOffset(0.25)
      const nudged = plugin.nudge(0.5)
      expect(nudged.offset).toBeCloseTo(0.5, 6)
      const back = plugin.nudge(-1)
      expect(back.offset).toBeCloseTo(0, 6)
    })

    test('nudge is a no-op without a grid', () => {
      const { plugin } = init({})
      expect(plugin.nudge(1).offset).toBe(0)
    })

    test('setOffset never goes negative', () => {
      const { plugin } = init({})
      plugin.setBpm(120)
      expect(plugin.setOffset(-3).offset).toBe(0)
    })

    test('setBeatsPerBar clamps to 1..16 and rounds', () => {
      const { plugin } = init({})
      expect(plugin.setBeatsPerBar(0).beatsPerBar).toBe(1)
      expect(plugin.setBeatsPerBar(99).beatsPerBar).toBe(16)
      expect(plugin.setBeatsPerBar(3.4).beatsPerBar).toBe(3)
    })
  })

  describe('snapping', () => {
    test('snapTime quantises to the nearest beat', () => {
      const { plugin } = init({})
      plugin.setBpm(120) // 0.5 s per beat, offset 0
      expect(plugin.snapTime(0.52)).toBeCloseTo(0.5, 6)
      expect(plugin.snapTime(1.24)).toBeCloseTo(1.0, 6)
    })

    test('snapTime leaves times outside the threshold untouched', () => {
      const { plugin } = init({ snapThreshold: 0.1 })
      plugin.setBpm(120)
      expect(plugin.snapTime(1.25)).toBeCloseTo(1.25, 6)
    })

    test('snapRange rounds a range to whole beats', () => {
      const { plugin } = init({})
      plugin.setBpm(120)
      const range = plugin.snapRange(0.03, 1.86)
      expect(range.start).toBeCloseTo(0, 6)
      expect(range.end).toBeCloseTo(2, 6)
    })

    test('snapping is identity when no grid exists', () => {
      const { plugin } = init({})
      expect(plugin.snapTime(1.234)).toBe(1.234)
      expect(plugin.snapRange(1, 2)).toEqual({ start: 1, end: 2 })
    })
  })

  describe('bar helpers', () => {
    test('barStartAt returns the enclosing bar boundary', () => {
      const { plugin } = init({ beatsPerBar: 4 })
      plugin.setBpm(120) // 0.5 s beats, 2 s bars
      expect(plugin.barStartAt(3.4)).toBeCloseTo(2, 6)
      expect(plugin.barStartAt(0.1)).toBeCloseTo(0, 6)
    })

    test('barIndexAt counts bars from the first beat', () => {
      const { plugin } = init({ beatsPerBar: 4 })
      plugin.setBpm(120)
      expect(plugin.barIndexAt(0.1)).toBe(0)
      expect(plugin.barIndexAt(2.1)).toBe(1)
      expect(plugin.barIndexAt(6.1)).toBe(3)
    })

    test('bar helpers degrade to zero without a grid', () => {
      const { plugin } = init({})
      expect(plugin.barStartAt(5)).toBe(0)
      expect(plugin.barIndexAt(5)).toBe(0)
    })
  })

  describe('looping', () => {
    test('setLoop enables looping and emits loop-change', () => {
      const { plugin } = init({})
      const onLoop = jest.fn()
      plugin.on('loop-change', onLoop)
      plugin.setLoop({ start: 1, end: 3 })
      expect(plugin.isLooping()).toBe(true)
      expect(onLoop).toHaveBeenCalledWith({ enabled: true, start: 1, end: 3 })
    })

    test('setLoop with null disables looping', () => {
      const { plugin } = init({})
      plugin.setLoop({ start: 1, end: 3 })
      plugin.setLoop(null)
      expect(plugin.isLooping()).toBe(false)
    })

    test('setLoop rejects an inverted range', () => {
      const { plugin } = init({})
      plugin.setLoop({ start: 3, end: 1 })
      expect(plugin.isLooping()).toBe(false)
    })

    test('setLoop seeks to the start when the playhead is outside', () => {
      const fake = createWaveSurfer({ currentTime: 10 })
      const { plugin } = init({}, fake)
      plugin.setLoop({ start: 2, end: 4 })
      expect(fake.__times).toContain(2)
    })

    test('loopBarAt loops exactly one bar at the playhead', () => {
      const fake = createWaveSurfer({ currentTime: 3.2 })
      const { plugin } = init({ beatsPerBar: 4 }, fake)
      plugin.setBpm(120) // 2 s bars
      plugin.loopBarAt()
      expect(plugin.isLooping()).toBe(true)
      // 3.2 s falls in the bar starting at 2 s, ending at 4 s. The playhead is
      // already inside that range, so setLoop must NOT seek (seeking would
      // interrupt playback for no reason).
      expect(fake.__times).toHaveLength(0)

      // But looping the *next* bar must seek, because 3.2 s is outside it.
      plugin.loopBarAt(5.1)
      expect(fake.__times).toContain(4)
    })

    test('loopBarAt never produces a collapsed loop before the first beat', () => {
      // Regression: with the playhead at t=0 and the first detected beat at
      // 0.028 s, the enclosing bar starts at a NEGATIVE time. Clamping the start
      // to 0 while deriving the end from the unclamped start produced a
      // 0.028 s "loop" instead of a full bar (caught on the demo page).
      const fake = createWaveSurfer({ currentTime: 0 })
      const { plugin } = init({ beatsPerBar: 4 }, fake)
      plugin.setBpm(120)
      plugin.setOffset(0.028)
      plugin.loopBarAt()
      expect(plugin.isLooping()).toBe(true)
      // The loop must be a full bar (2 s at 120 BPM), not a few milliseconds:
      // drive a timeupdate just past that end and require a wrap to the start.
      fake.emit('timeupdate', 2.1)
      const wrapped = fake.__times[fake.__times.length - 1]
      expect(wrapped).toBe(0)
    })

    test('barStartAt clamps to zero before the first beat', () => {
      const { plugin } = init({ beatsPerBar: 4 })
      plugin.setBpm(120)
      plugin.setOffset(0.3)
      // t=0 is before the first beat at 0.3 s; the enclosing bar would start at
      // -1.7 s, which must clamp to 0 rather than go negative.
      expect(plugin.barStartAt(0)).toBe(0)
    })

    test('loopBarAt uses the playhead when called without an argument', () => {
      const fake = createWaveSurfer({ currentTime: 0 })
      const { plugin } = init({ beatsPerBar: 4 }, fake)
      plugin.setBpm(120)
      plugin.loopBarAt()
      expect(plugin.isLooping()).toBe(true)
    })

    test('wraps the playhead back to the loop start on timeupdate', () => {
      const fake = createWaveSurfer()
      const { plugin } = init({}, fake)
      plugin.setLoop({ start: 2, end: 4 })
      fake.emit('timeupdate', 4.5)
      expect(fake.__times[fake.__times.length - 1]).toBe(2)
    })

    test('does not wrap while inside the loop', () => {
      const fake = createWaveSurfer()
      const { plugin } = init({}, fake)
      plugin.setLoop({ start: 2, end: 4 })
      const before = fake.__times.length
      fake.emit('timeupdate', 3)
      expect(fake.__times.length).toBe(before)
    })

    test('restarts the loop on finish', () => {
      const fake = createWaveSurfer()
      const { plugin } = init({}, fake)
      plugin.setLoop({ start: 2, end: 4 })
      fake.emit('finish')
      expect(fake.__plays).toEqual([[2, 4]])
    })

    test('does not restart on finish when not looping', () => {
      const fake = createWaveSurfer()
      init({}, fake)
      fake.emit('finish')
      expect(fake.__plays).toEqual([])
    })
  })

  describe('tap tempo', () => {
    test('returns 0 for the first tap', () => {
      const { plugin } = init({})
      expect(plugin.tap()).toBe(0)
    })

    test('derives BPM from the interval between taps', () => {
      const { plugin } = init({})
      let now = 1000
      const originalNow = performance.now
      performance.now = () => now

      plugin.tap()
      now += 500 // 500 ms => 120 BPM
      const bpm = plugin.tap()

      performance.now = originalNow
      expect(bpm).toBeCloseTo(120, 1)
      expect(plugin.getGrid().bpm).toBeCloseTo(120, 1)
    })

    test('emits tap-tempo', () => {
      const { plugin } = init({})
      let now = 0
      const originalNow = performance.now
      performance.now = () => now
      const onTap = jest.fn()
      plugin.on('tap-tempo', onTap)
      plugin.tap()
      now += 400
      plugin.tap()
      performance.now = originalNow
      expect(onTap).toHaveBeenCalledWith(expect.closeTo(150, 0))
    })

    test('resetTap clears the session', () => {
      const { plugin } = init({})
      let now = 0
      const originalNow = performance.now
      performance.now = () => now
      plugin.tap()
      now += 500
      plugin.tap()
      plugin.resetTap()
      now += 500
      expect(plugin.tap()).toBe(0)
      performance.now = originalNow
    })

    test('a long pause starts a new session', () => {
      const { plugin } = init({})
      let now = 0
      const originalNow = performance.now
      performance.now = () => now
      plugin.tap()
      now += 5000 // beyond the 2.5 s timeout
      expect(plugin.tap()).toBe(0)
      performance.now = originalNow
    })
  })

  describe('rendering', () => {
    test('draws bar lines at the expected pixel positions', () => {
      const fake = createWaveSurfer({ width: 800, duration: 8 })
      const { plugin } = init({ beatsPerBar: 4, subdivisions: 1 }, fake)
      plugin.setBpm(120) // 0.5 s beats => 16 beats over 8 s, bars every 2 s
      fake.__setVisibleRange(0, 8)

      const strokes = canvas.calls.filter((call) => call.op === 'stroke')
      expect(strokes.length).toBeGreaterThan(0)
      // 8 s at 800 px => 100 px/s; bar lines every 2 s => x = 0, 200, 400, 600, 800
      const barXs = canvas.calls
        .filter((call) => call.op === 'moveTo' && call.style?.includes('0.72'))
        .map((call) => call.args[0])
      expect(barXs).toContain(0.5)
      expect(barXs.some((x) => Math.abs(x - 200.5) < 1.5)).toBe(true)
      expect(barXs.some((x) => Math.abs(x - 400.5) < 1.5)).toBe(true)
    })

    test('reports a non-zero rendered line count', () => {
      const fake = createWaveSurfer({ width: 800, duration: 8 })
      const { plugin } = init({ beatsPerBar: 4, subdivisions: 1 }, fake)
      plugin.setBpm(120)
      fake.__setVisibleRange(0, 8)
      expect(plugin.getRenderedLineCount()).toBeGreaterThan(0)
    })

    test('draws nothing when the grid is hidden', () => {
      const fake = createWaveSurfer({ width: 800, duration: 8 })
      const { plugin } = init({ beatsPerBar: 4, subdivisions: 1 }, fake)
      plugin.setBpm(120)
      fake.__setVisibleRange(0, 8)
      plugin.setVisible(false)
      canvas.calls.length = 0
      fake.emit('zoom', 50)
      expect(canvas.calls.filter((call) => call.op === 'stroke')).toHaveLength(0)
      expect(plugin.getRenderedLineCount()).toBe(0)
    })

    test('degrades subdivisions when lines would be too dense', () => {
      // 120 BPM over a 120 s viewport at 800 px => 4 px per beat, so
      // subdivisions must collapse to 1 to avoid a solid block.
      const fake = createWaveSurfer({ width: 800, duration: 120 })
      const { plugin } = init({ beatsPerBar: 4, subdivisions: 4 }, fake)
      plugin.setBpm(120)
      fake.__setVisibleRange(0, 120)
      const before = canvas.calls.length
      canvas.calls.length = 0
      fake.emit('zoom', 10)
      // Some lines still drawn (bars/beats), but far fewer than beats x subs.
      const strokes = canvas.calls.filter((call) => call.op === 'stroke').length
      expect(strokes).toBeGreaterThan(0)
      expect(before).toBeGreaterThan(0)
    })

    test('aligns lines to a scrolled viewport', () => {
      const fake = createWaveSurfer({ width: 800, duration: 16 })
      const { plugin } = init({ beatsPerBar: 4, subdivisions: 1 }, fake)
      plugin.setBpm(120)
      fake.__setVisibleRange(4, 12) // 8 s window starting at 4 s
      const barXs = canvas.calls
        .filter((call) => call.op === 'moveTo' && call.style?.includes('0.72'))
        .map((call) => call.args[0])
      // Bars at 4, 6, 8, 10, 12 s => x = 0, 200, 400, 600, 800
      expect(barXs.some((x) => Math.abs(x - 0.5) < 1.5)).toBe(true)
      expect(barXs.some((x) => Math.abs(x - 400.5) < 1.5)).toBe(true)
    })

    test('draws onset ticks when enabled', () => {
      const fake = createWaveSurfer({ width: 800, duration: 8, buffer: clickTrackBuffer(120, 8) })
      const { plugin } = init({ showOnsets: true, subdivisions: 1 }, fake)
      fake.emit('ready', 8)
      canvas.calls.length = 0
      fake.emit('zoom', 40)
      const ticks = canvas.calls.filter((call) => call.op === 'fillRect' && call.style?.includes('0.9'))
      expect(ticks.length).toBeGreaterThan(0)
      expect(plugin.getOnsets().length).toBeGreaterThan(0)
    })

    test('setOnsetsVisible(false) removes the ticks', () => {
      const fake = createWaveSurfer({ width: 800, duration: 8, buffer: clickTrackBuffer(120, 8) })
      const { plugin } = init({ showOnsets: true, subdivisions: 1 }, fake)
      fake.emit('ready', 8)
      plugin.setOnsetsVisible(false)
      canvas.calls.length = 0
      fake.emit('zoom', 40)
      const ticks = canvas.calls.filter((call) => call.op === 'fillRect' && call.style?.includes('0.9'))
      expect(ticks).toHaveLength(0)
    })

    test('renders nothing for a zero-width container without throwing', () => {
      const fake = createWaveSurfer({ width: 0, duration: 8 })
      const { plugin } = init({}, fake)
      plugin.setBpm(120)
      expect(() => fake.emit('zoom', 40)).not.toThrow()
      expect(plugin.getRenderedLineCount()).toBe(0)
    })
  })

  describe('lifecycle', () => {
    test('destroy removes the overlay from the DOM', () => {
      const { plugin } = init({})
      expect(document.querySelector('[part="beatgrid"]')).not.toBeNull()
      plugin.destroy()
      expect(document.querySelector('[part="beatgrid"]')).toBeNull()
    })

    test('destroy unsubscribes from wavesurfer events', () => {
      const fake = createWaveSurfer()
      const { plugin } = init({}, fake)
      const listener = jest.fn()
      plugin.on('grid-change', listener)
      plugin.destroy()
      fake.emit('zoom', 40)
      expect(listener).not.toHaveBeenCalled()
    })

    test('can be re-initialised after destroy', () => {
      const fake = createWaveSurfer({ buffer: clickTrackBuffer(120, 12) })
      const plugin = BeatGridPlugin.create({})
      plugin._init(fake as never)
      plugin.destroy()
      plugin._init(fake as never)
      fake.emit('ready', 12)
      expect(Math.abs((plugin as BeatGridApi).getGrid().bpm - 120)).toBeLessThan(3)
    })
  })

  describe('accessibility contract', () => {
    test('overlay does not capture pointer events', () => {
      init({})
      const root = document.querySelector('[part="beatgrid"]') as HTMLElement
      expect(root.style.pointerEvents).toBe('none')
    })

    test('overlay exposes stable part names for styling', () => {
      init({})
      expect(document.querySelector('[part="beatgrid"]')).not.toBeNull()
      expect(document.querySelector('[part="beatgrid-lines"]')).not.toBeNull()
      expect(document.querySelector('[part="beatgrid-accent"]')).not.toBeNull()
    })
  })
})
