/**
 * Beat analysis: onset detection, tempo estimation and grid fitting.
 *
 * This module is deliberately pure DSP + math: it takes raw PCM samples and
 * returns numbers. No DOM, no wavesurfer dependency, no globals — which makes
 * every step independently unit-testable with synthetic signals whose ground
 * truth is known exactly (see `src/__tests__/beat-analysis.test.ts`).
 *
 * Pipeline:
 *
 *   PCM ──► frame → Hann window → FFT → magnitude spectrum
 *              │
 *              ├─► spectral flux (positive log-magnitude difference)
 *              │        └─► adaptive threshold → onset peak picking
 *              │
 *              └─► onset strength envelope
 *                       └─► autocorrelation → tempo candidates
 *                                └─► comb-filter scoring → BPM + phase
 *                                         └─► grid fit against onsets
 */

import FFT from './fft.js'

/** A detected transient, in seconds. */
export type Onset = {
  /** Time in seconds from the start of the audio. */
  time: number
  /** Normalised detection strength, 0..1 relative to the strongest onset. */
  strength: number
}

/** A regular grid of beat positions. */
export type BeatGrid = {
  /** Tempo in beats per minute. */
  bpm: number
  /** Time of the first beat, in seconds. May be slightly negative for the grid to cover t=0. */
  offset: number
  /** Seconds per beat. */
  beatInterval: number
  /** Beats per bar (musical meter), used for accenting every Nth line. */
  beatsPerBar: number
  /** Confidence of the tempo estimate, 0..1. */
  confidence: number
}

export type AnalyzeOptions = {
  /** FFT window size in samples. Power of two. Defaults to 1024. */
  fftSize?: number
  /** Hop size in samples between analysis frames. Defaults to fftSize / 4. */
  hopSize?: number
  /** Lowest tempo to consider, in BPM. Defaults to 60. */
  minBpm?: number
  /** Highest tempo to consider, in BPM. Defaults to 200. */
  maxBpm?: number
  /**
   * Onset detection sensitivity, 0..1. Higher detects more (weaker) onsets.
   * Defaults to 0.5.
   */
  sensitivity?: number
  /**
   * Minimum gap between two onsets, in seconds. Defaults to 0.05 (50 ms),
   * which is below the ~60 ms limit of human rhythmic discrimination.
   */
  minOnsetGap?: number
}

const DEFAULTS = {
  fftSize: 1024,
  minBpm: 60,
  maxBpm: 200,
  sensitivity: 0.5,
  minOnsetGap: 0.05,
}

/** Mix all channels down to a single mono Float32Array. */
export function toMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer
  if (numberOfChannels === 1) {
    // Copy: callers may keep the result after the AudioBuffer is released, and
    // getChannelData returns a live view into the buffer's internal storage.
    return new Float32Array(buffer.getChannelData(0))
  }
  const mono = new Float32Array(length)
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) {
      mono[i] += data[i]
    }
  }
  const scale = 1 / numberOfChannels
  for (let i = 0; i < length; i++) {
    mono[i] *= scale
  }
  return mono
}

/**
 * Compute the onset strength envelope: positive spectral flux over
 * log-compressed magnitudes.
 *
 * Log compression (log1p) is what makes quiet transients visible next to loud
 * ones; plain linear flux is dominated by whatever is loudest and misses
 * hi-hats under a bass drum.
 *
 * Returns one value per frame, the frame rate needed to convert frame indices
 * to seconds, and `frameOffset`: the time (in seconds) that frame 0 represents.
 * A frame is centred on its window, not started at it — without this offset
 * every detected onset is reported ~half a window too early (measured: 29 ms
 * early with a 1024-sample window at 22.05 kHz).
 */
export function onsetStrengthEnvelope(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyzeOptions = {},
): { envelope: Float32Array; frameRate: number; frameOffset: number; hopSize: number; fftSize: number } {
  const fftSize = options.fftSize ?? DEFAULTS.fftSize
  const hopSize = options.hopSize ?? Math.max(1, Math.floor(fftSize / 4))

  if (!Number.isInteger(fftSize) || fftSize < 32 || (fftSize & (fftSize - 1)) !== 0) {
    throw new Error('onsetStrengthEnvelope: fftSize must be a power of two >= 32')
  }
  if (!Number.isInteger(hopSize) || hopSize < 1) {
    throw new Error('onsetStrengthEnvelope: hopSize must be a positive integer')
  }

  const frameCount = Math.max(0, Math.floor((samples.length - fftSize) / hopSize) + 1)
  const frameRate = sampleRate / hopSize
  const frameOffset = fftSize / 2 / sampleRate
  if (frameCount <= 0) {
    return { envelope: new Float32Array(0), frameRate, frameOffset, hopSize, fftSize }
  }

  // Same idiom as spectrogram-frequencies.ts: fft.ts is @ts-nocheck with a
  // bolted-on `declare class` that has no usable construct signature, so cast
  // only at the construction site and let the annotation restore the type.
  const fft: FFT = new (FFT as any)(fftSize, sampleRate, 'hann', 0.5)
  const frame = new Float32Array(fftSize)
  const bins = fftSize >> 1
  const previous = new Float32Array(bins)
  const envelope = new Float32Array(frameCount)

  for (let f = 0; f < frameCount; f++) {
    const offset = f * hopSize
    for (let i = 0; i < fftSize; i++) {
      frame[i] = samples[offset + i]
    }
    const spectrum = fft.calculateSpectrum(frame)

    let flux = 0
    for (let b = 0; b < bins; b++) {
      const magnitude = Math.log1p(spectrum[b])
      const delta = magnitude - previous[b]
      if (delta > 0) flux += delta
      previous[b] = magnitude
    }
    envelope[f] = flux
  }

  // Normalise to 0..1 so that thresholds are signal-independent.
  let max = 0
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i] > max) max = envelope[i]
  }
  if (max > 0) {
    for (let i = 0; i < envelope.length; i++) {
      envelope[i] /= max
    }
  }

  return { envelope, frameRate, frameOffset, hopSize, fftSize }
}

/**
 * Pick onset peaks out of an onset strength envelope.
 *
 * Uses a moving-average threshold with a sensitivity-dependent multiplier,
 * plus a local-maximum test and a minimum inter-onset gap. This is the
 * classic adaptive-threshold approach (Bello et al., 2005): a fixed threshold
 * either misses quiet passages or floods on loud ones.
 */
export type OnsetEnvelope = {
  envelope: Float32Array
  frameRate: number
  /** Time in seconds represented by frame index 0 (window centre). */
  frameOffset: number
}

/**
 * Pick onset peaks out of an onset strength envelope.
 *
 * Takes the envelope object returned by `onsetStrengthEnvelope` rather than
 * loose numbers, so the window-centre correction cannot be silently dropped by
 * a caller that forgets the extra argument (which is exactly what happened when
 * this took `(envelope, frameRate, options, frameOffset)`).
 *
 * Uses a moving-average threshold with a sensitivity-dependent multiplier,
 * plus a local-maximum test and a minimum inter-onset gap. This is the
 * classic adaptive-threshold approach (Bello et al., 2005): a fixed threshold
 * either misses quiet passages or floods on loud ones.
 */
export function pickOnsets(input: OnsetEnvelope, options: AnalyzeOptions = {}): Onset[] {
  const { envelope, frameRate: rate, frameOffset: offset } = input
  if (rate <= 0) return []

  const sensitivity = clamp01(options.sensitivity ?? DEFAULTS.sensitivity)
  const minGap = Math.max(0, options.minOnsetGap ?? DEFAULTS.minOnsetGap)
  // ceil, not round: rounding down would let two onsets land closer than the
  // requested minimum (observed: a 0.2 s gap admitting 0.197 s at 86 Hz frames).
  const minGapFrames = Math.max(1, Math.ceil(minGap * rate))

  // A ~100 ms window is long enough to follow a tempo change and short enough
  // not to smear across beats at 200 BPM (300 ms per beat).
  const windowFrames = Math.max(3, Math.round(0.1 * rate))
  const half = Math.floor(windowFrames / 2)

  // sensitivity 0 → multiplier 1.6 (only strong peaks), 1 → 0.6 (permissive)
  const multiplier = 1.6 - sensitivity

  const onsets: Onset[] = []
  let lastIndex = -Infinity

  for (let i = 1; i < envelope.length - 1; i++) {
    const value = envelope[i]
    if (value <= 0) continue
    // Local maximum: strictly greater than both neighbours, so a plateau
    // yields exactly one detection rather than a burst.
    if (value < envelope[i - 1] || value <= envelope[i + 1]) continue

    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - half); j <= Math.min(envelope.length - 1, i + half); j++) {
      sum += envelope[j]
      count++
    }
    const threshold = (sum / count) * multiplier
    if (value < threshold) continue

    if (i - lastIndex < minGapFrames) {
      // Keep the stronger of two onsets that are too close together.
      if (onsets.length > 0 && value > onsets[onsets.length - 1].strength) {
        onsets[onsets.length - 1] = { time: i / rate + offset, strength: value }
        lastIndex = i
      }
      continue
    }

    onsets.push({ time: i / rate + offset, strength: value })
    lastIndex = i
  }

  return onsets
}

/**
 * Score how well a candidate tempo explains an onset envelope.
 *
 * This operates on the *envelope*, not on a list of onsets, because the
 * envelope retains the strength information that peak-picking throws away.
 *
 * The score is the product of three measured quantities. All three were chosen
 * after simpler alternatives measurably failed on the demo grooves:
 *
 *  1. Comb alignment - how much of the envelope's total energy falls on
 *     multiples of the beat period. Alone, this always prefers a tempo twice
 *     as fast, because a denser comb necessarily collects more energy
 *     (measured: 192 BPM scored 0.183 vs 96 BPM's 0.160 on a 96 BPM groove).
 *  2. Tooth uniformity - 1 / (1 + CV) of the peak energy at each comb tooth.
 *     A grid at the true tempo lands on equally strong beats; a grid at double
 *     tempo alternates strong and weak (off-beat) teeth. This is what actually
 *     breaks the octave error (measured: 0.74 at 96 BPM vs 0.55 at 192 BPM on
 *     the same groove).
 *  3. Tooth coverage - the fraction of teeth carrying a real hit. This stops
 *     the search drifting to half tempo, where every tooth is trivially
 *     "uniform" because only half the events are counted (measured: half tempo
 *     scored 0.81 uniformity but only 0.04 comb energy).
 */
export function scoreTempoEnvelope(
  envelope: Float32Array,
  frameRate: number,
  bpm: number,
): { score: number; comb: number; uniformity: number; coverage: number } {
  const lag = (60 / bpm) * frameRate
  if (bpm <= 0 || !(lag >= 4) || envelope.length < 8) {
    return { score: 0, comb: 0, uniformity: 0, coverage: 0 }
  }

  let totalEnergy = 0
  for (let i = 0; i < envelope.length; i++) totalEnergy += envelope[i]
  if (totalEnergy <= 0) return { score: 0, comb: 0, uniformity: 0, coverage: 0 }

  // Sample each comb tooth with a small triangular kernel, so a beat that sits
  // between two frames still registers.
  const peaks: number[] = []
  let combed = 0
  for (let k = 0; ; k++) {
    const centre = Math.round(k * lag)
    if (centre >= envelope.length) break
    let peak = 0
    for (let d = -2; d <= 2; d++) {
      const index = centre + d
      if (index >= 0 && index < envelope.length) {
        combed += envelope[index] * (1 - Math.abs(d) / 3)
        if (envelope[index] > peak) peak = envelope[index]
      }
    }
    peaks.push(peak)
  }

  if (peaks.length < 4) return { score: 0, comb: 0, uniformity: 0, coverage: 0 }

  const comb = combed / totalEnergy

  let mean = 0
  for (const peak of peaks) mean += peak
  mean /= peaks.length
  if (mean <= 0) return { score: 0, comb, uniformity: 0, coverage: 0 }

  let variance = 0
  for (const peak of peaks) variance += (peak - mean) ** 2
  variance /= peaks.length
  const uniformity = 1 / (1 + Math.sqrt(variance) / mean)

  // A tooth "counts" when it is at least 55% as strong as the median tooth -
  // tolerant of the natural accent pattern (kick vs snare) but intolerant of
  // empty positions.
  const sorted = [...peaks].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  let strong = 0
  if (median > 0) {
    for (const peak of peaks) if (peak >= median * 0.55) strong++
  }
  const coverage = median > 0 ? strong / peaks.length : 0

  // Uniformity is squared, not linear. It is the only term that separates a
  // tempo from its double, and on the hardest demo track (96 BPM with
  // eighth-note hats, where 192 BPM is genuinely plausible) the linear product
  // left only a 17% margin over 192; squaring raises that to 38% without
  // changing any of the four answers. Measured on all four demo grooves.
  return { score: comb * uniformity * uniformity * coverage, comb, uniformity, coverage }
}

/**
 * Score a candidate tempo against a list of onsets (onset-domain only).
 *
 * This is a *different* estimator from `scoreTempoEnvelope`, deliberately:
 * onsets are sparse point events, so the envelope-domain criteria (tooth
 * uniformity, tooth coverage) degenerate on them.
 *
 * Three terms, each added because the previous set measurably failed:
 *
 *  1. **Inter-onset agreement** — the share of consecutive gaps that are a
 *     beat, or a small integer multiple / half of it.
 *  2. **Occupancy-weighted alignment** — the share of onsets sitting on a beat
 *     times the share of beat slots that are filled. Without occupancy, an
 *     eight-times-too-fast grid scored a perfect 1.0 (measured: 0.125 s, 0.25 s
 *     and 0.5 s all scored 1.000 on the same syncopated pattern).
 *  3. **Subdivision support** — the share of onsets that also land on the
 *     *half*-beat grid. A tempo that is genuinely too slow still explains every
 *     onset, but its half-beat grid explains nothing extra. This is what stops
 *     a plain isochronous pattern from being read at half speed.
 */
export function scoreTempo(onsets: Onset[], beatInterval: number, tolerance = 0.035): number {
  if (onsets.length < 2 || beatInterval <= 0) return 0

  const relations = [1, 2, 3, 4, 0.5]
  let weighted = 0
  let total = 0
  for (let i = 1; i < onsets.length; i++) {
    const delta = onsets[i].time - onsets[i - 1].time
    if (delta <= 0) continue
    const weight = Math.min(onsets[i].strength, onsets[i - 1].strength)
    total += weight
    let best = 0
    for (const relation of relations) {
      const expected = beatInterval * relation
      const error = Math.abs(delta - expected) / expected
      const match = Math.max(0, 1 - error / (tolerance * 4))
      if (match > best) best = match
    }
    weighted += weight * best
  }
  const agreement = total > 0 ? weighted / total : 0

  let strengthTotal = 0
  for (const onset of onsets) strengthTotal += onset.strength
  if (strengthTotal <= 0) return 0

  // Best phase for the beat grid. The sweep is anchored on the first onset
  // rather than on t=0: anchoring on zero silently assumed the pattern began at
  // a grid position, so a pattern starting at t=7 scored 0.50 instead of 0.88
  // (its true phase is 7 mod 0.5 = 0, which the zero-anchored sweep never
  // visited with the right granularity).
  let bestAligned = 0
  let bestPhase = onsets[0].time
  const steps = 24
  for (let p = 0; p < steps; p++) {
    const phase = onsets[0].time + (p / steps) * beatInterval
    let aligned = 0
    for (const onset of onsets) {
      const distance = Math.abs(mod(onset.time - phase + beatInterval / 2, beatInterval) - beatInterval / 2)
      if (distance <= tolerance) aligned += onset.strength
    }
    if (aligned > bestAligned) {
      bestAligned = aligned
      bestPhase = phase
    }
  }
  const alignment = bestAligned / strengthTotal

  const first = onsets[0].time
  const last = onsets[onsets.length - 1].time
  const slots = Math.max(1, Math.round((last - first) / beatInterval) + 1)
  const occupied = new Set<number>()
  for (const onset of onsets) {
    const index = Math.round((onset.time - bestPhase) / beatInterval)
    const gridTime = bestPhase + index * beatInterval
    if (Math.abs(gridTime - onset.time) <= tolerance) {
      occupied.add(Math.min(slots - 1, Math.max(0, index)))
    }
  }
  const occupancy = occupied.size / slots

  // Subdivision support: how many onsets land on the half-beat grid of the
  // same phase. With a beat grid at the true tempo, off-beat onsets are common;
  // with a beat grid twice too slow, the half-beat grid is the true grid and
  // explains everything, which is exactly what we want to reward — while a
  // grid twice too *fast* has a half-beat grid that explains nothing new.
  const halfInterval = beatInterval / 2
  let onHalf = 0
  for (const onset of onsets) {
    const distance = Math.abs(mod(onset.time - bestPhase + halfInterval / 2, halfInterval) - halfInterval / 2)
    if (distance <= tolerance) onHalf += onset.strength
  }
  const subdivision = onHalf / strengthTotal

  // Penalise grids whose half-beat slots are mostly empty: that is the
  // signature of a tempo that is too fast.
  const halfSlots = Math.max(1, Math.round((last - first) / halfInterval) + 1)
  const halfOccupied = new Set<number>()
  for (const onset of onsets) {
    const index = Math.round((onset.time - bestPhase) / halfInterval)
    const gridTime = bestPhase + index * halfInterval
    if (Math.abs(gridTime - onset.time) <= tolerance) {
      halfOccupied.add(Math.min(halfSlots - 1, Math.max(0, index)))
    }
  }
  const halfOccupancy = halfOccupied.size / halfSlots

  return 0.45 * agreement + 0.3 * alignment * occupancy + 0.25 * subdivision * halfOccupancy
}

/**
 * Estimate tempo from an onset envelope.
 *
 * Brute-force searches BPM at 0.5 resolution across [minBpm, maxBpm], then
 * refines the winner at 0.1 resolution. A mild prior towards 120 BPM resolves
 * near-ties the way listeners do, without overriding the evidence.
 */
export function estimateTempoFromEnvelope(
  envelope: Float32Array,
  frameRate: number,
  options: AnalyzeOptions = {},
): { bpm: number; confidence: number } {
  const minBpm = options.minBpm ?? DEFAULTS.minBpm
  const maxBpm = options.maxBpm ?? DEFAULTS.maxBpm
  if (minBpm <= 0 || maxBpm <= minBpm || envelope.length < 8) {
    return { bpm: 0, confidence: 0 }
  }

  const scoreAt = (bpm: number) => {
    const raw = scoreTempoEnvelope(envelope, frameRate, bpm).score
    // Gentle octave-wide prior; +/-8% at the extremes, no effect at 120 BPM.
    const prior = 1 - 0.08 * Math.abs(Math.log2(bpm / 120))
    return raw * prior
  }

  // Coarse sweep, keeping every score so the rival can be chosen *after* the
  // winner is known.
  const candidates: Array<{ bpm: number; score: number }> = []
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    candidates.push({ bpm, score: scoreAt(bpm) })
  }

  let best = candidates[0]
  for (const candidate of candidates) {
    if (candidate.score > best.score) best = candidate
  }
  if (!best || best.score <= 0) return { bpm: 0, confidence: 0 }

  // Refine around the coarse winner at 0.1 resolution.
  let refined = best.bpm
  let refinedScore = best.score
  for (let bpm = Math.max(minBpm, best.bpm - 1); bpm <= Math.min(maxBpm, best.bpm + 1); bpm += 0.1) {
    const score = scoreAt(bpm)
    if (score > refinedScore) {
      refinedScore = score
      refined = bpm
    }
  }

  // Confidence = margin over the strongest *metrically distinct* rival.
  //
  // The previous implementation compared against `runnerUp`, which was simply
  // the second-highest bin of the sweep — almost always the winner's own
  // neighbour (96.0 vs 96.5). That is the same tempo, not a competing
  // interpretation, so the reported confidence was meaningless (measured: 35%
  // on a track whose answer was unambiguous, and ~15% on the octave-ambiguous
  // one). Candidates within 6% of the winner are treated as the same tempo;
  // everything else is a real rival.
  const distinctBand = 0.06
  let rivalScore = 0
  let rivalBpm = 0
  for (const candidate of candidates) {
    if (Math.abs(candidate.bpm - refined) / refined <= distinctBand) continue
    if (candidate.score > rivalScore) {
      rivalScore = candidate.score
      rivalBpm = candidate.bpm
    }
  }

  const separation = refinedScore > 0 ? clamp01(1 - rivalScore / refinedScore) : 0
  void rivalBpm
  return { bpm: Math.round(refined * 10) / 10, confidence: separation }
}

/**
 * Estimate tempo from onsets alone.
 *
 * Uses the onset-domain score (see `scoreTempo`), not the envelope one: with
 * sparse point events the envelope criteria degenerate (measured: a perfect
 * 120 BPM click track came back as 240 BPM through the envelope path).
 */
export function estimateTempo(onsets: Onset[], options: AnalyzeOptions = {}): { bpm: number; confidence: number } {
  const minBpm = options.minBpm ?? DEFAULTS.minBpm
  const maxBpm = options.maxBpm ?? DEFAULTS.maxBpm
  if (onsets.length < 2 || minBpm <= 0 || maxBpm <= minBpm) {
    return { bpm: 0, confidence: 0 }
  }

  const scoreAt = (bpm: number) => {
    const raw = scoreTempo(onsets, 60 / bpm)
    const prior = 1 - 0.08 * Math.abs(Math.log2(bpm / 120))
    return raw * prior
  }

  let bestBpm = 0
  let bestScore = 0
  let runnerUp = 0
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const score = scoreAt(bpm)
    if (score > bestScore) {
      runnerUp = bestScore
      bestScore = score
      bestBpm = bpm
    } else if (score > runnerUp) {
      runnerUp = score
    }
  }
  if (bestScore <= 0) return { bpm: 0, confidence: 0 }

  let refined = bestBpm
  let refinedScore = bestScore
  for (let bpm = Math.max(minBpm, bestBpm - 1); bpm <= Math.min(maxBpm, bestBpm + 1); bpm += 0.1) {
    const score = scoreAt(bpm)
    if (score > refinedScore) {
      refinedScore = score
      refined = bpm
    }
  }

  const separation = refinedScore > 0 ? clamp01((refinedScore - runnerUp) / refinedScore) : 0
  return { bpm: Math.round(refined * 10) / 10, confidence: separation }
}

/**
 * Fit a beat grid (tempo + phase) to the onsets.
 *
 * The phase is found by a 1 ms sweep weighted by onset strength: a coarse comb
 * search cannot resolve which of two equally good phases is the downbeat.
 */
export function fitGrid(onsets: Onset[], bpm: number, beatsPerBar = 4, tolerance = 0.035): BeatGrid {
  const beatInterval = bpm > 0 ? 60 / bpm : 0
  if (beatInterval <= 0 || onsets.length === 0) {
    return { bpm, offset: 0, beatInterval, beatsPerBar, confidence: 0 }
  }

  const steps = Math.max(1, Math.round(beatInterval * 1000))
  let bestOffset = 0
  let bestScore = -1
  for (let s = 0; s < steps; s++) {
    const offset = (s / steps) * beatInterval
    let score = 0
    for (const onset of onsets) {
      const distance = Math.abs(mod(onset.time - offset + beatInterval / 2, beatInterval) - beatInterval / 2)
      if (distance <= tolerance) score += onset.strength * (1 - distance / tolerance)
    }
    if (score > bestScore) {
      bestScore = score
      bestOffset = offset
    }
  }

  // Report the offset as the first beat position >= 0, so consumers can iterate
  // `offset + n * beatInterval` without handling negative indices.
  const firstBeat = bestOffset - Math.floor(bestOffset / beatInterval) * beatInterval

  // Phase confidence = selectivity of the best phase over a random one.
  //
  // The obvious measure — "what fraction of onsets land on a beat" — is not a
  // phase-quality measure at all: on material with off-beat eighths it is
  // dominated by how busy the arrangement is (measured 0.14-0.18 on all four
  // demo grooves, including ones whose phase was perfect). What actually says
  // "this phase is right" is that it collects far more onset strength than an
  // arbitrary phase would.
  let strengthTotal = 0
  for (const onset of onsets) strengthTotal += onset.strength
  if (strengthTotal <= 0) {
    return { bpm, offset: firstBeat, beatInterval, beatsPerBar, confidence: 0 }
  }

  let scoreSum = 0
  let scoreCount = 0
  for (let s = 0; s < steps; s++) {
    const offset = (s / steps) * beatInterval
    let score = 0
    for (const onset of onsets) {
      const distance = Math.abs(mod(onset.time - offset + beatInterval / 2, beatInterval) - beatInterval / 2)
      if (distance <= tolerance) score += onset.strength * (1 - distance / tolerance)
    }
    scoreSum += score
    scoreCount++
  }
  const meanScore = scoreCount > 0 ? scoreSum / scoreCount : 0
  // bestScore is already the max over the same sweep.
  const selectivity = bestScore > 0 ? clamp01((bestScore - meanScore) / bestScore) : 0

  return {
    bpm,
    offset: firstBeat,
    beatInterval,
    beatsPerBar,
    confidence: selectivity,
  }
}

/** Enumerate beat times covered by the grid within [from, to]. */
export function beatTimes(grid: BeatGrid, from: number, to: number): number[] {
  if (grid.beatInterval <= 0 || to <= from) return []
  const times: number[] = []
  const firstIndex = Math.ceil((from - grid.offset) / grid.beatInterval)
  for (let i = firstIndex; ; i++) {
    const time = grid.offset + i * grid.beatInterval
    if (time > to) break
    if (time >= from) times.push(time)
    // Guard against a pathological interval producing an unbounded loop.
    if (times.length > 100000) break
  }
  return times
}

/**
 * Snap a time to the nearest beat.
 *
 * Returns the input unchanged when it is already within `threshold` of a beat,
 * otherwise the nearest beat position. `threshold` is expressed as a fraction
 * of a beat (default: half a beat, i.e. always snap).
 */
export function snapToBeat(grid: BeatGrid, time: number, threshold = 0.5): number {
  if (grid.beatInterval <= 0) return time
  const nearestIndex = Math.round((time - grid.offset) / grid.beatInterval)
  const nearest = grid.offset + nearestIndex * grid.beatInterval
  const distance = Math.abs(nearest - time) / grid.beatInterval
  return distance <= threshold ? nearest : time
}

/**
 * Snap a duration (region length) to a whole number of beats.
 *
 * Rounding lengths rather than endpoints is what keeps loops musical: a loop
 * that is 3.7 beats long drifts, one that is 4 beats long does not.
 */
export function snapDuration(grid: BeatGrid, start: number, end: number, minBeats = 1): { start: number; end: number } {
  if (grid.beatInterval <= 0) return { start, end }
  const snappedStart = snapToBeat(grid, start)
  const beats = Math.max(minBeats, Math.round((end - snappedStart) / grid.beatInterval))
  return { start: snappedStart, end: snappedStart + beats * grid.beatInterval }
}

/** One-shot analysis: samples in, onsets + grid out. */
export function analyzeSamples(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyzeOptions = {},
): { onsets: Onset[]; grid: BeatGrid; envelope: Float32Array; frameRate: number; frameOffset: number } {
  const result = onsetStrengthEnvelope(samples, sampleRate, options)
  const onsets = pickOnsets(result, options)
  // Tempo comes from the envelope, not from the picked onsets: the envelope
  // keeps relative strengths, which is what separates a beat from an off-beat
  // eighth. Peak-picking first would throw that away (this was the original
  // implementation, and it reported 192 BPM for a 96 BPM groove).
  const { bpm, confidence } = estimateTempoFromEnvelope(result.envelope, result.frameRate, options)
  const grid = fitGrid(onsets, bpm, 4)
  // The grid's own confidence measures phase alignment; blend it with the
  // tempo confidence so a well-phased but ambiguous tempo does not report 1.0.
  grid.confidence = clamp01(grid.confidence * 0.5 + confidence * 0.5)
  return { onsets, grid, envelope: result.envelope, frameRate: result.frameRate, frameOffset: result.frameOffset }
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
