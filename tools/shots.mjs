#!/usr/bin/env node
/**
 * Capture the delivery screenshots.
 *
 * Each shot is taken in a specific, reproducible state (not "whatever the page
 * looked like"), so the images in the report correspond to claims that can be
 * re-derived: the loop range, the BPM, the zoom level are all set explicitly.
 *
 * Usage: node tools/shots.mjs [baseUrl]
 */

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8899'
const outDir = join(root, 'shots')
mkdirSync(outDir, { recursive: true })

const executablePath = join(
  process.env.LOCALAPPDATA ?? '',
  'ms-playwright',
  'chromium-1248',
  'chrome-win64',
  'chrome.exe',
)

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 })

await page.goto(`${baseUrl}/demo/index.html`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => window.__beatgridDemo?.getState().bpm > 0, { timeout: 20000 })

// ── 1. Overview: 120 BPM track, grid + onsets visible ─────────────────────
await page.click('.track[data-file="groove-120.wav"]')
await page.waitForFunction(
  () => {
    const state = window.__beatgridDemo?.getState()
    return state && Math.abs(state.bpm - 120) < 2
  },
  { timeout: 20000 },
)
await page.waitForTimeout(500)
await page.screenshot({ path: join(outDir, '01-overview.png'), fullPage: false })

// ── 2. Loop active: one bar highlighted, status text updated ──────────────
await page.evaluate(() => window.__beatgridDemo.loopCurrent())
await page.waitForTimeout(300)
await page.screenshot({ path: join(outDir, '02-loop.png'), fullPage: false })

// ── 3. Detail crop of the waveform: three-tier grid + onset ticks ─────────
const wave = await page.$('.stage__wave')
if (wave) {
  await wave.screenshot({ path: join(outDir, '03-grid-detail.png') })
}

// ── 4. Tap tempo state ────────────────────────────────────────────────────
await page.evaluate(() => window.__beatgridDemo.setBpm(128))
await page.click('#tap')
await page.waitForTimeout(120)
await page.click('#tap')
await page.waitForTimeout(200)
await page.screenshot({ path: join(outDir, '04-tap-tempo.png'), fullPage: false })

// ── 5. Responsive breakpoints ─────────────────────────────────────────────
for (const bp of [
  { name: '05-tablet-1024', width: 1024, height: 900 },
  { name: '06-mobile-390', width: 390, height: 844 },
]) {
  await page.setViewportSize({ width: bp.width, height: bp.height })
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(outDir, `${bp.name}.png`), fullPage: false })
}

// ── 6. Full page at desktop (includes the method / results sections) ──────
await page.setViewportSize({ width: 1440, height: 980 })
await page.waitForTimeout(400)
await page.screenshot({ path: join(outDir, '07-full-page.png'), fullPage: true })

await browser.close()
console.log('screenshots written to shots/')
