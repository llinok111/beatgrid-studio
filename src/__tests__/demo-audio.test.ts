/**
 * Accuracy test against the *actual demo assets* — a 16-bar drum groove with
 * kick, snare, hats and a sustained bassline. This is a materially harder case
 * than the synthetic click tracks in beat-analysis.test.ts, so it is kept in
 * its own suite with its own tolerances.
 *
 * Ground truth comes from scripts/make-demo-audio.mjs: the BPM is a constant
 * in the generator, not something inferred from the audio.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeSamples } from '../beat-analysis.js'

/** Minimal WAV reader for the 16-bit mono PCM the generator emits. */
function readWav(path: string): { samples: Float32Array; sampleRate: number } {
  const buffer = readFileSync(path)
  const sampleRate = buffer.readUInt32LE(24)
  const channels = buffer.readUInt16LE(22)
  const bitsPerSample = buffer.readUInt16LE(34)
  if (bitsPerSample !== 16 || channels !== 1) {
    throw new Error(`unexpected WAV format: ${channels}ch/${bitsPerSample}bit`)
  }
  const dataSize = buffer.readUInt32LE(40)
  const count = dataSize / 2
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    samples[i] = buffer.readInt16LE(44 + i * 2) / 32768
  }
  return { samples, sampleRate }
}

const demoDir = join(__dirname, '..', '..', 'demo', 'audio')
const manifest = JSON.parse(readFileSync(join(demoDir, 'tracks.json'), 'utf8')) as Array<{
  file: string
  bpm: number
  bars: number
  beatsPerBar: number
}>

describe('demo assets', () => {
  test('the manifest and the files on disk agree', () => {
    expect(manifest.length).toBeGreaterThanOrEqual(3)
    for (const track of manifest) {
      const { samples, sampleRate } = readWav(join(demoDir, track.file))
      expect(sampleRate).toBe(44100)
      // bars * beatsPerBar beats + 1 s tail, within a second.
      const expectedSeconds = (track.bars * track.beatsPerBar * 60) / track.bpm + 1
      expect(Math.abs(samples.length / sampleRate - expectedSeconds)).toBeLessThan(1)
    }
  })

  test.each(manifest.map((track) => [track.file, track.bpm] as const))(
    'recovers %s at %i BPM within 1.5%%',
    (file, truth) => {
      const { samples, sampleRate } = readWav(join(demoDir, file))
      const { grid, onsets } = analyzeSamples(samples, sampleRate)
      const error = Math.abs(grid.bpm - truth) / truth
      expect(onsets.length).toBeGreaterThan(20)
      expect(error).toBeLessThanOrEqual(0.015)
    },
  )

  test('reports a confidence that reflects a distinct rival, not a neighbouring bin', () => {
    // Regression: confidence used to compare the winner against the second-
    // highest 0.5 BPM bin (i.e. itself), so a correct, unambiguous detection
    // reported ~15-35%. It must now be a margin over a metrically distinct
    // tempo, and an unambiguous track must therefore clear 0.5.
    const { samples, sampleRate } = readWav(join(demoDir, 'groove-120.wav'))
    const { grid } = analyzeSamples(samples, sampleRate)
    expect(grid.bpm).toBeGreaterThan(118)
    expect(grid.confidence).toBeGreaterThan(0.5)
  })

  test('reports lower confidence on the octave-ambiguous track than on the clear one', () => {
    // The 96 BPM groove has hats on every eighth, so 192 BPM is a genuine
    // alternative reading. Its margin must be measurably smaller than the
    // 120 BPM track's — if this ever inverts, the scorer has stopped
    // distinguishing "easy" from "ambiguous".
    const ambiguous = analyzeSamples(
      ...(Object.values(readWav(join(demoDir, 'groove-96.wav'))) as [Float32Array, number]),
    )
    const clear = analyzeSamples(...(Object.values(readWav(join(demoDir, 'groove-120.wav'))) as [Float32Array, number]))
    expect(ambiguous.grid.confidence).toBeLessThan(clear.grid.confidence)
    expect(ambiguous.grid.confidence).toBeGreaterThan(0.2)
  })

  test('grid phase lands close to the true downbeat', () => {
    // The generator starts the first kick at t=0, so the first beat is at 0.
    const { samples, sampleRate } = readWav(join(demoDir, 'groove-120.wav'))
    const { grid } = analyzeSamples(samples, sampleRate)
    expect(grid.beatInterval).toBeCloseTo(0.5, 2)
    // offset is reported in [0, beatInterval); a correct estimate is ~0 or ~0.5.
    const distanceToZero = Math.min(grid.offset, grid.beatInterval - grid.offset)
    expect(distanceToZero).toBeLessThan(0.06)
  })
})
