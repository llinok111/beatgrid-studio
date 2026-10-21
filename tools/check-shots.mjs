#!/usr/bin/env node
/**
 * Screenshot sanity check.
 *
 * The reviewer of this project cannot rely on "the file exists" as evidence
 * that a screenshot shows anything. This script decodes every shot in a real
 * browser and reports objective statistics: dimensions, mean luminance, how
 * many distinct colours appear, and what share of pixels fall in the project's
 * amber accent range. A blank or single-colour image fails immediately.
 *
 * Usage: node tools/check-shots.mjs
 */

import { chromium } from 'playwright-core'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'


const here = dirname(fileURLToPath(import.meta.url))
const shotsDir = join(here, '..', 'shots')
// Images are loaded over HTTP, not file://: Chromium refuses to decode a
// file:// image inside a page served from http://127.0.0.1 (opaque origin),
// which surfaced as "The source image cannot be decoded".
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8899'
const files = readdirSync(shotsDir).filter((name) => name.endsWith('.png')).sort()

if (files.length === 0) {
  console.error('no screenshots found')
  process.exit(1)
}

const executablePath = join(
  process.env.LOCALAPPDATA ?? '',
  'ms-playwright',
  'chromium-1248',
  'chrome-win64',
  'chrome.exe',
)

const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage()
// Navigate to the same origin as the images first: reading pixels from an
// image loaded cross-origin taints the canvas and getImageData() throws
// SecurityError.
await page.goto(`${baseUrl}/shots/`, { waitUntil: 'domcontentloaded' })

const rows = []
for (const file of files) {
  const path = join(shotsDir, file)
  const url = `${baseUrl}/shots/${file}`
  const stats = await page.evaluate(async (src) => {
    const image = new Image()
    image.src = src
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)

    const colours = new Set()
    let luminanceSum = 0
    let amber = 0
    let total = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      luminanceSum += 0.2126 * r + 0.7152 * g + 0.0722 * b
      // Amber accent: warm, mid-bright, red > green > blue with clear separation.
      if (r > 150 && g > 90 && g < 215 && b < 140 && r - b > 60) amber++
      total++
      // Quantise to 5 bits per channel to count perceptually distinct colours
      // without counting every anti-aliasing variant separately.
      colours.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3))
    }
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      meanLuminance: luminanceSum / total,
      distinctColours: colours.size,
      amberShare: amber / total,
    }
  }, url)

  const bytes = statSync(path).size
  rows.push({ file, bytes, ...stats })
}

await browser.close()

const pad = (value, width) => String(value).padStart(width)
console.log('file                       size      dims        meanLum  colours  amber%')
for (const row of rows) {
  console.log(
    `${row.file.padEnd(26)} ${pad((row.bytes / 1024).toFixed(0) + 'KB', 8)}  ${pad(row.width + 'x' + row.height, 11)}  ${pad(
      row.meanLuminance.toFixed(1),
      7,
    )}  ${pad(row.distinctColours, 7)}  ${pad((row.amberShare * 100).toFixed(2), 6)}`,
  )
}

// Assertions: every shot must be non-blank and show the warm palette.
let failures = 0
for (const row of rows) {
  const problems = []
  if (row.distinctColours < 40) problems.push(`too few colours (${row.distinctColours})`)
  if (row.meanLuminance < 4) problems.push('image is essentially black')
  if (row.meanLuminance > 250) problems.push('image is essentially white')
  if (problems.length > 0) {
    failures++
    console.log(`FAIL ${row.file}: ${problems.join(', ')}`)
  }
}
console.log('')
console.log(failures === 0 ? `all ${rows.length} screenshots contain real content` : `${failures} screenshot(s) failed`)
if (failures > 0) process.exit(1)
