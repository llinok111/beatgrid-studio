/**
 * Ground-truth tests for the beat analysis engine.
 *
 * Every signal here is synthesised with a *known* BPM, phase and onset count,
 * so the assertions are checks against ground truth rather than against
 * snapshots of whatever the implementation happened to produce.
 */

import {
  analyzeSamples,
  beatTimes,
  estimateTempo,
  fitGrid,
  onsetStrengthEnvelope,
  pickOnsets,
  scoreTempo,
  snapDuration,
  snapToBeat,
  toMono,
  type Onset,
} from '../beat-analysis.js'

const SAMPLE_RATE = 22050

/** Deterministic pseudo-random noise (LCG), so runs are reproducible. */
function makeNoise(seed = 12345) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return (state / 0x7fffffff) * 2 - 1
  }
}

/**
 * A click track: short broadband noise bursts (12 ms exponential decay) at a
 * fixed tempo. This is the cleanest possible onset ground truth — exactly one
 * transient per beat, known position, no sustained energy between hits.
 */
function clickTrack(bpm: number, seconds: number, offset = 0.1, sampleRate = SAMPLE_RATE): Float32Array {
  const length = Math.floor(seconds * sampleRate)
  const out = new Float32Array(length)
  const interval = 60 / bpm
  const burstLength = Math.floor(0.012 * sampleRate)
  const rand = makeNoise()
  for (let t = offset; t < seconds; t += interval) {
    const start = Math.floor(t * sampleRate)
    for (let i = 0; i < burstLength && start + i < length; i++) {
      out[start + i] += rand() * Math.exp((-6 * i) / burstLength) * 0.8
    }
  }
  return out
}

/**
 * A kick-and-hihat pattern: a low sine thump on beats 1 and 3, a bright noise
 * tick on every eighth. Tests that the detector survives polyphonic material
 * and that it does not simply count every transient as a beat.
 */
function drumPattern(bpm: number, seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  const length = Math.floor(seconds * sampleRate)
  const out = new Float32Array(length)
  const beat = 60 / bpm
  const rand = makeNoise(999)
  const thumpLength = Math.floor(0.09 * sampleRate)
  const tickLength = Math.floor(0.015 * sampleRate)

  for (let bar = 0; bar * beat * 4 < seconds; bar++) {
    for (let b = 0; b < 4; b++) {
      const beatTime = (bar * 4 + b) * beat
      if (beatTime >= seconds) break
      // Kick on beats 0 and 2
      if (b % 2 === 0) {
        const start = Math.floor(beatTime * sampleRate)
        for (let i = 0; i < thumpLength && start + i < length; i++) {
          const env = Math.exp((-5 * i) / thumpLength)
          out[start + i] += Math.sin((2 * Math.PI * 55 * i) / sampleRate) * env * 0.7
        }
      }
      // Hi-hat tick on every eighth
      for (const eighth of [0, 0.5]) {
        const tickTime = beatTime + eighth * beat
        if (tickTime >= seconds) continue
        const start = Math.floor(tickTime * sampleRate)
        for (let i = 0; i < tickLength && start + i < length; i++) {
          out[start + i] += rand() * Math.exp((-8 * i) / tickLength) * 0.25
        }
      }
    }
  }
  return out
}

function makeAudioBuffer(channels: Float32Array[], sampleRate = SAMPLE_RATE): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    duration: channels[0].length / sampleRate,
    getChannelData: (index: number) => channels[index],
  } as unknown as AudioBuffer
}

describe('toMono', () => {
  test('returns a copy of a mono channel, not a live view', () => {
    const channel = new Float32Array([0.1, 0.2, 0.3])
    const mono = toMono(makeAudioBuffer([channel]))
    expect(Array.from(mono)).toEqual([0.1, 0.2, 0.3].map((v) => Math.fround(v)))
    channel[0] = 0.9
    expect(mono[0]).not.toBe(channel[0])
  })

  test('averages stereo channels', () => {
    const left = new Float32Array([1, 0, -1])
    const right = new Float32Array([0, 1, -1])
    const mono = toMono(makeAudioBuffer([left, right]))
    expect(mono[0]).toBeCloseTo(0.5, 6)
    expect(mono[1]).toBeCloseTo(0.5, 6)
    expect(mono[2]).toBeCloseTo(-1, 6)
  })

  test('averages three channels', () => {
    const mono = toMono(makeAudioBuffer([new Float32Array([0.3]), new Float32Array([0.6]), new Float32Array([0.9])]))
    expect(mono[0]).toBeCloseTo(0.6, 6)
  })
})

describe('onsetStrengthEnvelope', () => {
  test('rejects a non power-of-two fftSize', () => {
    expect(() => onsetStrengthEnvelope(new Float32Array(4096), SAMPLE_RATE, { fftSize: 1000 })).toThrow(/power of two/)
  })

  test('rejects a non-positive hopSize', () => {
    expect(() => onsetStrengthEnvelope(new Float32Array(4096), SAMPLE_RATE, { hopSize: 0 })).toThrow(/hopSize/)
  })

  test('returns an empty envelope when the signal is shorter than one frame', () => {
    const result = onsetStrengthEnvelope(new Float32Array(100), SAMPLE_RATE, { fftSize: 1024 })
    expect(result.envelope).toHaveLength(0)
    expect(result.frameRate).toBeCloseTo(SAMPLE_RATE / 256, 6)
    expect(result.frameOffset).toBeCloseTo(512 / SAMPLE_RATE, 9)
  })

  test('normalises to a 0..1 maximum', () => {
    const { envelope } = onsetStrengthEnvelope(clickTrack(120, 4), SAMPLE_RATE)
    const max = Math.max(...envelope)
    expect(max).toBeCloseTo(1, 6)
    expect(Math.min(...envelope)).toBeGreaterThanOrEqual(0)
  })

  test('frame count matches the hop arithmetic exactly', () => {
    const samples = new Float32Array(5000)
    const fftSize = 1024
    const hopSize = 256
    const env = onsetStrengthEnvelope(samples, SAMPLE_RATE, { fftSize, hopSize })
    expect(env.envelope).toHaveLength(Math.floor((5000 - fftSize) / hopSize) + 1)
  })
})

describe('pickOnsets', () => {
  test('finds one onset per click in a clean click track', () => {
    const bpm = 120
    const seconds = 10
    const samples = clickTrack(bpm, seconds)
    const env = onsetStrengthEnvelope(samples, SAMPLE_RATE)
    const onsets = pickOnsets(env, {})
    // 0.1 s offset, one click every 0.5 s, for 10 s => 20 clicks.
    expect(onsets.length).toBeGreaterThanOrEqual(19)
    expect(onsets.length).toBeLessThanOrEqual(21)
  })

  test('onset times are within 25 ms of the true click positions', () => {
    const bpm = 120
    const offset = 0.1
    const samples = clickTrack(bpm, 10, offset)
    const env = onsetStrengthEnvelope(samples, SAMPLE_RATE)
    const onsets = pickOnsets(env, {})

    const interval = 60 / bpm
    for (const onset of onsets.slice(0, 12)) {
      const index = Math.round((onset.time - offset) / interval)
      const truth = offset + index * interval
      expect(Math.abs(onset.time - truth)).toBeLessThan(0.025)
    }
  })

  test('higher sensitivity yields at least as many onsets as lower sensitivity', () => {
    const samples = drumPattern(120, 8)
    const env = onsetStrengthEnvelope(samples, SAMPLE_RATE)
    const strict = pickOnsets(env, { sensitivity: 0 })
    const loose = pickOnsets(env, { sensitivity: 1 })
    expect(loose.length).toBeGreaterThanOrEqual(strict.length)
  })

  test('respects the minimum inter-onset gap', () => {
    const samples = drumPattern(150, 6)
    const env = onsetStrengthEnvelope(samples, SAMPLE_RATE)
    const onsets = pickOnsets(env, { minOnsetGap: 0.2 })
    for (let i = 1; i < onsets.length; i++) {
      expect(onsets[i].time - onsets[i - 1].time).toBeGreaterThanOrEqual(0.2 - 1e-6)
    }
  })

  test('reports no onsets for pure silence', () => {
    const env = onsetStrengthEnvelope(new Float32Array(SAMPLE_RATE * 2), SAMPLE_RATE)
    expect(pickOnsets(env, {})).toHaveLength(0)
  })
})

describe('scoreTempo', () => {
  const onsets: Onset[] = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5].map((time) => ({ time, strength: 1 }))

  test('scores the true beat interval highest for a syncopated pattern', () => {
    // A purely isochronous pattern cannot distinguish a tempo from its double
    // (every onset fits both grids) — that ambiguity is real, not a bug. Use a
    // pattern with a half-beat and a two-beat gap, which only the true tempo
    // explains without invoking an unlikely relation.
    const syncopated: Onset[] = [
      { time: 0.0, strength: 1 },
      { time: 0.5, strength: 1 },
      { time: 1.0, strength: 1 },
      { time: 1.25, strength: 0.6 }, // eighth-note push
      { time: 1.5, strength: 1 },
      { time: 2.0, strength: 1 },
      { time: 2.5, strength: 1 },
    ]
    const atTruth = scoreTempo(syncopated, 0.5)
    const tooSlow = scoreTempo(syncopated, 1.5)
    const tooFast = scoreTempo(syncopated, 0.125)
    expect(atTruth).toBeGreaterThan(tooSlow)
    expect(atTruth).toBeGreaterThan(tooFast)
  })

  test('penalises a grid that is too fast (mostly empty slots)', () => {
    // Isochronous onsets every 0.5 s: the true beat interval and any integer
    // multiple align perfectly, but a grid four times faster leaves 3 of every
    // 4 slots empty and must score strictly lower.
    const isochronous: Onset[] = Array.from({ length: 9 }, (_, i) => ({ time: i * 0.5, strength: 1 }))
    expect(scoreTempo(isochronous, 0.5)).toBeGreaterThan(scoreTempo(isochronous, 0.125))
  })

  test('is invariant to the absolute start time (phase is searched, not assumed)', () => {
    // A pattern that begins at t=7 must score the same as one beginning at t=0,
    // because the phase search covers the whole beat.
    const base: Onset[] = Array.from({ length: 9 }, (_, i) => ({ time: i * 0.5, strength: 1 }))
    const shifted: Onset[] = base.map((o) => ({ ...o, time: o.time + 7 }))
    expect(scoreTempo(shifted, 0.5)).toBeCloseTo(scoreTempo(base, 0.5), 6)
  })

  test('returns zero for fewer than two onsets', () => {
    expect(scoreTempo([{ time: 0, strength: 1 }], 0.5)).toBe(0)
  })

  test('returns zero for a non-positive interval', () => {
    expect(scoreTempo(onsets, 0)).toBe(0)
  })
})

describe('estimateTempo', () => {
  test.each([
    [90, 0.5],
    [120, 0.5],
    [128, 0.5],
    [140, 0.5],
  ])('recovers %i BPM from a click track within 1.5%%', (truth, toleranceRatio) => {
    const samples = clickTrack(truth, 20)
    const env = onsetStrengthEnvelope(samples, SAMPLE_RATE)
    const onsets = pickOnsets(env, {})
    const { bpm } = estimateTempo(onsets, {})
    const error = Math.abs(bpm - truth) / truth
    expect(error).toBeLessThanOrEqual(toleranceRatio / 100)
  })

  test('does not lock onto double or half tempo', () => {
    const truth = 120
    const samples = clickTrack(truth, 20)
    const env = onsetStrengthEnvelope(samples, SAMPLE_RATE)
    const onsets = pickOnsets(env, {})
    const { bpm } = estimateTempo(onsets, {})
    expect(Math.abs(bpm - truth)).toBeLessThan(3)
    expect(Math.abs(bpm - truth * 2)).toBeGreaterThan(30)
    expect(Math.abs(bpm - truth / 2)).toBeGreaterThan(30)
  })

  test('respects minBpm/maxBpm bounds', () => {
    const samples = clickTrack(120, 12)
    const env = onsetStrengthEnvelope(samples, SAMPLE_RATE)
    const onsets = pickOnsets(env, {})
    const { bpm } = estimateTempo(onsets, { minBpm: 100, maxBpm: 130 })
    expect(bpm).toBeGreaterThanOrEqual(100)
    expect(bpm).toBeLessThanOrEqual(130)
  })

  test('returns zero confidence for an empty onset list', () => {
    expect(estimateTempo([], {})).toEqual({ bpm: 0, confidence: 0 })
  })
})

describe('fitGrid', () => {
  test('recovers the phase of a click track', () => {
    const bpm = 120
    const offset = 0.35
    const onsets: Onset[] = []
    for (let t = offset; t < 10; t += 60 / bpm) onsets.push({ time: t, strength: 1 })
    const grid = fitGrid(onsets, bpm)
    expect(grid.beatInterval).toBeCloseTo(0.5, 6)
    // offset is reported as the first beat >= 0, which must be congruent to
    // the true phase modulo the beat interval.
    const phaseError = Math.abs(((grid.offset - offset) % 0.5) + 0.5) % 0.5
    expect(Math.min(phaseError, 0.5 - phaseError)).toBeLessThan(0.005)
  })

  test('reports high phase confidence for perfectly aligned onsets', () => {
    const onsets: Onset[] = []
    for (let i = 0; i < 16; i++) onsets.push({ time: i * 0.5, strength: 1 })
    // Not exactly 1: confidence is the best phase's selectivity over a random
    // phase, and neighbouring phase steps still overlap a 35 ms tolerance, so
    // the mean phase score is non-zero. 0.93 is the correct ceiling here.
    const confidence = fitGrid(onsets, 120).confidence
    expect(confidence).toBeGreaterThan(0.9)
    expect(confidence).toBeLessThanOrEqual(1)
  })

  test('phase confidence is low when onsets ignore the beat', () => {
    // Onsets scattered by a deterministic pseudo-random offset, so no phase
    // explains them better than any other. (A periodic offset such as
    // `(i % 7) * x` is NOT suitable here: it repeats every 7 beats and
    // therefore aligns with the beat grid again.)
    const onsets: Onset[] = []
    let seed = 42
    for (let i = 0; i < 60; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      onsets.push({ time: i * 0.5 + (seed / 0x7fffffff) * 0.5, strength: 1 })
    }
    expect(fitGrid(onsets, 120).confidence).toBeLessThan(0.5)
  })

  test('degrades gracefully with no onsets', () => {
    const grid = fitGrid([], 120)
    expect(grid.confidence).toBe(0)
    expect(grid.offset).toBe(0)
    expect(grid.beatInterval).toBeCloseTo(0.5, 6)
  })

  test('honours a non-4 beats-per-bar', () => {
    const onsets: Onset[] = Array.from({ length: 12 }, (_, i) => ({ time: i * 0.5, strength: 1 }))
    expect(fitGrid(onsets, 120, 3).beatsPerBar).toBe(3)
  })
})

describe('beatTimes', () => {
  const grid = { bpm: 120, offset: 0.1, beatInterval: 0.5, beatsPerBar: 4, confidence: 1 }

  test('enumerates beats inside the requested window', () => {
    const times = beatTimes(grid, 0, 2)
    expect(times).toEqual([0.1, 0.6, 1.1, 1.6])
  })

  test('returns an empty list for an inverted window', () => {
    expect(beatTimes(grid, 2, 1)).toEqual([])
  })

  test('returns an empty list for a zero interval', () => {
    expect(beatTimes({ ...grid, beatInterval: 0 }, 0, 2)).toEqual([])
  })

  test('handles windows that start after the grid offset', () => {
    expect(beatTimes(grid, 1.2, 1.7)).toEqual([1.6])
  })
})

describe('snapToBeat', () => {
  const grid = { bpm: 120, offset: 0, beatInterval: 0.5, beatsPerBar: 4, confidence: 1 }

  test('snaps to the nearest beat', () => {
    expect(snapToBeat(grid, 0.52)).toBeCloseTo(0.5, 9)
    expect(snapToBeat(grid, 1.24)).toBeCloseTo(1.0, 9)
  })

  test('leaves the time untouched when outside the threshold', () => {
    expect(snapToBeat(grid, 1.25, 0.2)).toBeCloseTo(1.25, 9)
  })

  test('is a no-op for a zero interval grid', () => {
    expect(snapToBeat({ ...grid, beatInterval: 0 }, 1.234)).toBe(1.234)
  })
})

describe('snapDuration', () => {
  const grid = { bpm: 120, offset: 0, beatInterval: 0.5, beatsPerBar: 4, confidence: 1 }

  test('rounds a loop to whole beats', () => {
    const { start, end } = snapDuration(grid, 0.02, 1.87)
    expect(start).toBeCloseTo(0, 9)
    expect(end).toBeCloseTo(2.0, 9)
    expect((end - start) / grid.beatInterval).toBeCloseTo(4, 9)
  })

  test('enforces a minimum length in beats', () => {
    const { start, end } = snapDuration(grid, 1.0, 1.05, 2)
    expect((end - start) / grid.beatInterval).toBeCloseTo(2, 9)
  })

  test('is a no-op for a zero interval grid', () => {
    expect(snapDuration({ ...grid, beatInterval: 0 }, 1, 2)).toEqual({ start: 1, end: 2 })
  })
})

describe('analyzeSamples end-to-end', () => {
  test('analyses a 128 BPM click track in reasonable time', () => {
    const samples = clickTrack(128, 20)
    const started = performance.now()
    const { onsets, grid } = analyzeSamples(samples, SAMPLE_RATE)
    const elapsed = performance.now() - started
    expect(Math.abs(grid.bpm - 128) / 128).toBeLessThan(0.015)
    expect(onsets.length).toBeGreaterThan(35)
    // Generous ceiling: this guards against accidental O(n^2) regressions, not
    // against normal variance. Real timings are recorded in the report.
    expect(elapsed).toBeLessThan(4000)
  })

  test('recovers tempo from a polyphonic drum pattern', () => {
    const { grid } = analyzeSamples(drumPattern(100, 16), SAMPLE_RATE)
    // The pattern has kicks on beats 1/3 and hats on every eighth, so 100, 200
    // and 50 are all defensible; accept an octave-equivalent answer but
    // require it to be metrically consistent.
    const ratio = grid.bpm / 100
    const octave = Math.abs(Math.log2(ratio))
    expect(Math.abs(octave - Math.round(octave))).toBeLessThan(0.03)
  })

  test('produces a usable grid for silence without throwing', () => {
    const { onsets, grid } = analyzeSamples(new Float32Array(SAMPLE_RATE), SAMPLE_RATE)
    expect(onsets).toHaveLength(0)
    expect(grid.bpm).toBe(0)
  })
})
