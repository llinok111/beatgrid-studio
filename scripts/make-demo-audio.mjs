#!/usr/bin/env node
/**
 * Generate the demo audio assets used by `demo/index.html`.
 *
 * The material is synthesised rather than downloaded so that (a) the demo
 * works offline and (b) the tempo is known exactly — the demo's on-screen
 * readout can be compared against a ground truth instead of against itself.
 *
 * Usage: node scripts/make-demo-audio.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'demo', 'audio')
mkdirSync(outDir, { recursive: true })

const SAMPLE_RATE = 44100

function makeRandom(seed) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return (state / 0xffffffff) * 2 - 1
  }
}

/** One-pole low-pass, used to shape noise into a hat vs a snare. */
function lowPass(samples, cutoff, sampleRate) {
  const rc = 1 / (2 * Math.PI * cutoff)
  const dt = 1 / sampleRate
  const alpha = dt / (rc + dt)
  let previous = 0
  for (let i = 0; i < samples.length; i++) {
    previous += alpha * (samples[i] - previous)
    samples[i] = previous
  }
  return samples
}

function kick(length) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE
    // Pitch drops 120 -> 45 Hz over the first 40 ms: the classic "thump".
    const frequency = 45 + 75 * Math.exp(-t / 0.035)
    const phase = 2 * Math.PI * (45 * t + 75 * 0.035 * (1 - Math.exp(-t / 0.035)))
    void frequency
    out[i] = Math.sin(phase) * Math.exp(-t / 0.12)
  }
  return out
}

function hat(length, rand) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    out[i] = rand() * Math.exp(-i / (0.008 * SAMPLE_RATE))
  }
  return lowPass(out, 9000, SAMPLE_RATE)
}

function snare(length, rand) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE
    out[i] = (rand() * 0.7 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-t / 0.09)
  }
  return out
}

function add(buffer, sample, at, gain = 1) {
  const start = Math.floor(at * SAMPLE_RATE)
  for (let i = 0; i < sample.length; i++) {
    const index = start + i
    if (index >= 0 && index < buffer.length) buffer[index] += sample[i] * gain
  }
}

/**
 * A 16-bar groove at `bpm`, with a four-on-the-floor kick, backbeat snare and
 * eighth-note hats. Returns a mono Float32Array.
 */
function groove(bpm, bars = 16) {
  const beat = 60 / bpm
  const total = bars * 4 * beat + 1
  const buffer = new Float32Array(Math.ceil(total * SAMPLE_RATE))
  const rand = makeRandom(7)

  const kickSample = kick(Math.floor(0.35 * SAMPLE_RATE))
  const hatSample = hat(Math.floor(0.06 * SAMPLE_RATE), rand)
  const snareSample = snare(Math.floor(0.2 * SAMPLE_RATE), rand)

  // A simple Am-F-C-G bassline, one note per bar, to give the analyser
  // sustained content between transients (a harder case than pure clicks).
  const bassNotes = [110, 87.31, 130.81, 98]

  for (let bar = 0; bar < bars; bar++) {
    for (let b = 0; b < 4; b++) {
      const time = (bar * 4 + b) * beat
      add(buffer, kickSample, time, 0.9)
      if (b === 1 || b === 3) add(buffer, snareSample, time, 0.45)
      for (const eighth of [0, 0.5]) {
        add(buffer, hatSample, time + eighth * beat, eighth === 0 ? 0.2 : 0.14)
      }
    }
    // Bass: root on beat 1, fifth on beat 3, decaying sine.
    const root = bassNotes[bar % 4]
    const bassLength = Math.floor(beat * 1.8 * SAMPLE_RATE)
    const bassBuffer = new Float32Array(bassLength)
    for (let i = 0; i < bassLength; i++) {
      const t = i / SAMPLE_RATE
      bassBuffer[i] = Math.sin(2 * Math.PI * root * t) * Math.exp(-t / (beat * 0.9)) * 0.35
    }
    add(buffer, bassBuffer, bar * 4 * beat)
    add(buffer, bassBuffer, bar * 4 * beat + 2 * beat)
  }

  return buffer
}

/** Normalise to -1 dBFS peak and convert to 16-bit PCM WAV. */
function toWav(samples) {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  const gain = peak > 0 ? 0.891 / peak : 1

  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // PCM chunk size
  buffer.writeUInt16LE(1, 20) // PCM format
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28)
  buffer.writeUInt16LE(bytesPerSample, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] * gain))
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * bytesPerSample)
  }
  return buffer
}

const tracks = [
  { name: 'groove-96.wav', bpm: 96, bars: 12 },
  { name: 'groove-120.wav', bpm: 120, bars: 16 },
  { name: 'groove-128.wav', bpm: 128, bars: 16 },
  { name: 'groove-140.wav', bpm: 140, bars: 16 },
]

for (const track of tracks) {
  const samples = groove(track.bpm, track.bars)
  const wav = toWav(samples)
  writeFileSync(join(outDir, track.name), wav)
  const seconds = (samples.length / SAMPLE_RATE).toFixed(2)
  console.log(`${track.name}: ${track.bpm} BPM, ${seconds}s, ${(wav.length / 1024).toFixed(0)} KB`)
}

// Also write a manifest so the demo can label the ground truth.
writeFileSync(
  join(outDir, 'tracks.json'),
  JSON.stringify(
    tracks.map((t) => ({
      file: t.name,
      bpm: t.bpm,
      bars: t.bars,
      beatsPerBar: 4,
      // Synthetic, generated by this script — no third-party rights involved.
      license: 'CC0-1.0 (generated by scripts/make-demo-audio.mjs)',
    })),
    null,
    2,
  ),
)
console.log('wrote tracks.json')
