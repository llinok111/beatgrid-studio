/**
 * BeatGrid Studio demo.
 *
 * Everything here drives the *built* library (dist/), not the TypeScript
 * sources, so the page is an end-to-end check of the shipped artefacts.
 */

import WaveSurfer from '../dist/wavesurfer.esm.js'
import BeatGridPlugin from '../dist/plugins/beatgrid.esm.js'

const TRACKS = await fetch('./audio/tracks.json').then((response) => response.json())

const el = (id) => document.getElementById(id)

const ui = {
  trackList: el('track-list'),
  play: el('play'),
  clock: el('clock'),
  duration: el('duration'),
  volume: el('volume'),
  waveform: el('waveform'),
  badgeBpm: el('badge-bpm'),
  badgeConf: el('badge-conf'),
  badgeOnsets: el('badge-onsets'),
  bpm: el('bpm'),
  bpmOut: el('bpm-out'),
  phase: el('phase'),
  phaseOut: el('phase-out'),
  beats: el('beats'),
  subdiv: el('subdiv'),
  sensitivity: el('sensitivity'),
  sensOut: el('sens-out'),
  showGrid: el('show-grid'),
  showOnsets: el('show-onsets'),
  snapRegions: el('snap-regions'),
  tap: el('tap'),
  tapHint: el('tap-hint'),
  reanalyze: el('reanalyze'),
  reset: el('reset'),
  loopBar: el('loop-bar'),
  loopClear: el('loop-clear'),
  loopBars: el('loop-bars'),
  loopStatus: el('loop-status'),
  roBpm: el('ro-bpm'),
  roTruth: el('ro-truth'),
  roError: el('ro-error'),
  roOnsets: el('ro-onsets'),
  roConf: el('ro-conf'),
  roLines: el('ro-lines'),
}

let wavesurfer = null
let beatgrid = null
let currentTrack = null
/** User's phase offset in seconds, applied on top of the detected offset. */
let phaseOffset = 0
let detectedOffset = 0

// ── Formatting ────────────────────────────────────────────────────────────

const formatClock = (seconds, decimals = 2) => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${rest.toFixed(decimals).padStart(decimals > 0 ? 3 + decimals : 2, '0')}`
}

const formatDuration = (seconds) => (Number.isFinite(seconds) ? formatClock(seconds, 0) : '0:00')

// ── Track list ────────────────────────────────────────────────────────────

const renderTracks = () => {
  ui.trackList.innerHTML = ''
  for (const track of TRACKS) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'track'
    button.dataset.file = track.file
    button.setAttribute('aria-current', String(track === TRACKS[0]))

    const bars = document.createElement('span')
    bars.className = 'track__bars'
    bars.setAttribute('aria-hidden', 'true')
    // A tiny deterministic bar pattern keyed off the BPM, purely decorative.
    for (let i = 0; i < 4; i++) {
      const bar = document.createElement('i')
      bar.style.height = `${5 + ((track.bpm >> (i * 2)) % 9) + i}px`
      bars.appendChild(bar)
    }

    const name = document.createElement('span')
    name.className = 'track__name'
    name.textContent = track.file.replace('.wav', '').replace('groove-', 'Groove ')

    const bpm = document.createElement('span')
    bpm.className = 'track__bpm'
    bpm.textContent = `${track.bpm} BPM`

    button.append(bars, name, bpm)
    button.addEventListener('click', () => loadTrack(track))
    item.appendChild(button)
    ui.trackList.appendChild(item)
  }
}

// ── Grid sync ─────────────────────────────────────────────────────────────

const syncReadout = () => {
  if (!beatgrid) return
  const grid = beatgrid.getGrid()
  const onsets = beatgrid.getOnsets()
  const truth = currentTrack?.bpm ?? 0
  const error = truth > 0 && grid.bpm > 0 ? Math.abs(grid.bpm - truth) / truth : null

  ui.badgeBpm.textContent = grid.bpm > 0 ? `${grid.bpm.toFixed(1)} BPM` : 'BPM —'
  ui.badgeConf.textContent = grid.bpm > 0 ? `置信度 ${(grid.confidence * 100).toFixed(0)}%` : '置信度 —'
  ui.badgeOnsets.textContent = `瞬态 ${onsets.length}`

  ui.bpm.value = grid.bpm > 0 ? String(grid.bpm) : '120'
  ui.bpmOut.textContent = grid.bpm > 0 ? grid.bpm.toFixed(1) : '—'

  ui.roBpm.textContent = grid.bpm > 0 ? grid.bpm.toFixed(1) : '—'
  ui.roTruth.textContent = truth > 0 ? String(truth) : '—'
  ui.roError.textContent = error === null ? '—' : `${(error * 100).toFixed(2)}%`
  ui.roOnsets.textContent = String(onsets.length)
  ui.roConf.textContent = grid.bpm > 0 ? `${(grid.confidence * 100).toFixed(0)}%` : '—'
  // One rAF: the plugin repaints on the same signal tick.
  requestAnimationFrame(() => {
    ui.roLines.textContent = String(beatgrid.getRenderedLineCount())
  })
}

const applyPhase = () => {
  if (!beatgrid) return
  const grid = beatgrid.getGrid()
  if (grid.beatInterval <= 0) return
  // setOffset takes an absolute time; re-derive it from the detected base plus
  // the user's slider so dragging does not accumulate error.
  beatgrid.setOffset(Math.max(0, detectedOffset + phaseOffset))
  ui.phaseOut.textContent = `${Math.round(phaseOffset * 1000)} ms`
  syncReadout()
}

// ── Loading ───────────────────────────────────────────────────────────────

const loadTrack = async (track) => {
  currentTrack = track
  for (const button of ui.trackList.querySelectorAll('.track')) {
    button.setAttribute('aria-current', String(button.dataset.file === track.file))
  }

  if (wavesurfer) {
    wavesurfer.destroy()
    wavesurfer = null
    beatgrid = null
  }

  phaseOffset = 0
  ui.phase.value = '0'
  ui.phaseOut.textContent = '0 ms'
  ui.loopStatus.textContent = '未启用'
  ui.loopStatus.classList.remove('is-active')

  beatgrid = BeatGridPlugin.create({
    beatsPerBar: Number(ui.beats.value),
    subdivisions: Number(ui.subdiv.value),
    showGrid: ui.showGrid.checked,
    showOnsets: ui.showOnsets.checked,
    snapRegions: ui.snapRegions.checked,
    analysis: { sensitivity: Number(ui.sensitivity.value) },
  })

  wavesurfer = WaveSurfer.create({
    container: ui.waveform,
    // Warm, desaturated waveform so the amber grid reads as an overlay rather
    // than competing with it. A mid-tone wave colour plus thin bars keeps the
    // envelope legible under the grid lines.
    waveColor: '#8a7360',
    progressColor: '#c9862f',
    cursorColor: '#f6bd63',
    cursorWidth: 2,
    height: 220,
    barWidth: 1,
    barGap: 1,
    barRadius: 0,
    normalize: true,
    url: `./audio/${track.file}`,
    plugins: [beatgrid],
  })

  wavesurfer.on('ready', () => {
    ui.duration.textContent = `/ ${formatDuration(wavesurfer.getDuration())}`
    // The plugin auto-analyses on 'ready'; read back the phase it found.
    const grid = beatgrid.getGrid()
    detectedOffset = grid.offset
    syncReadout()
  })

  // Plugin events are emitted on the PLUGIN, not forwarded to the WaveSurfer
  // instance (upstream registerPlugin() only calls plugin._init()). Listening on
  // `wavesurfer` for these silently never fires — which is exactly the bug this
  // demo hit: the loop status label stayed at "未启用".
  beatgrid.on('grid-ready', () => {
    detectedOffset = beatgrid.getGrid().offset
    syncReadout()
  })

  beatgrid.on('grid-change', syncReadout)
  beatgrid.on('onsets-ready', syncReadout)
  beatgrid.on('tap-tempo', syncReadout)

  wavesurfer.on('timeupdate', (time) => {
    ui.clock.textContent = formatClock(time)
    // The rendered-line count changes with zoom/scroll, so refresh it while
    // playing at a low rate rather than per frame.
    if (Math.random() < 0.02) ui.roLines.textContent = String(beatgrid.getRenderedLineCount())
  })

  wavesurfer.on('play', () => {
    ui.play.classList.add('is-playing')
    ui.play.querySelector('.btn__label').textContent = '暂停'
    ui.play.querySelector('.btn__icon').textContent = '❚❚'
  })

  wavesurfer.on('pause', () => {
    ui.play.classList.remove('is-playing')
    ui.play.querySelector('.btn__label').textContent = '播放'
    ui.play.querySelector('.btn__icon').textContent = '▶'
  })

  wavesurfer.on('finish', () => {
    ui.play.classList.remove('is-playing')
    ui.play.querySelector('.btn__label').textContent = '播放'
    ui.play.querySelector('.btn__icon').textContent = '▶'
  })

  beatgrid.on('loop-change', (state) => {
    if (state.enabled) {
      ui.loopStatus.textContent = `循环 ${formatClock(state.start)} → ${formatClock(state.end)}`
      ui.loopStatus.classList.add('is-active')
    } else {
      ui.loopStatus.textContent = '未启用'
      ui.loopStatus.classList.remove('is-active')
    }
  })

  wavesurfer.setVolume(Number(ui.volume.value))
}

// ── Controls ──────────────────────────────────────────────────────────────

ui.play.addEventListener('click', () => {
  if (!wavesurfer) return
  void wavesurfer.playPause()
})

ui.volume.addEventListener('input', () => {
  wavesurfer?.setVolume(Number(ui.volume.value))
})

ui.bpm.addEventListener('input', () => {
  if (!beatgrid) return
  beatgrid.setBpm(Number(ui.bpm.value))
  detectedOffset = beatgrid.getGrid().offset
  phaseOffset = 0
  ui.phase.value = '0'
  ui.phaseOut.textContent = '0 ms'
  syncReadout()
})

ui.phase.addEventListener('input', () => {
  phaseOffset = Number(ui.phase.value) / 1000
  applyPhase()
})

ui.beats.addEventListener('change', () => {
  beatgrid?.setBeatsPerBar(Number(ui.beats.value))
  syncReadout()
})

ui.subdiv.addEventListener('change', () => {
  if (!beatgrid) return
  // Subdivisions are a render option; re-create the overlay with the new value
  // by reloading the plugin options through a fresh analysis pass is overkill,
  // so reload the track with the new setting (cheap: audio is cached).
  const track = currentTrack
  if (track) void loadTrack(track)
})

ui.sensitivity.addEventListener('input', () => {
  ui.sensOut.textContent = Number(ui.sensitivity.value).toFixed(2)
})

ui.sensitivity.addEventListener('change', () => {
  // Sensitivity only affects analysis, so re-run it rather than reload.
  if (!beatgrid) return
  beatgrid.analyze()
  detectedOffset = beatgrid.getGrid().offset
  syncReadout()
})

ui.showGrid.addEventListener('change', () => {
  beatgrid?.setVisible(ui.showGrid.checked)
})

ui.showOnsets.addEventListener('change', () => {
  beatgrid?.setOnsetsVisible(ui.showOnsets.checked)
})

ui.snapRegions.addEventListener('change', () => {
  // Region snapping is wired at construction; reload to apply.
  const track = currentTrack
  if (track) void loadTrack(track)
})

ui.tap.addEventListener('click', () => {
  if (!beatgrid) return
  const bpm = beatgrid.tap()
  ui.tap.classList.add('is-tapping')
  window.clearTimeout(ui.tap._resetTimer)
  ui.tap._resetTimer = window.setTimeout(() => ui.tap.classList.remove('is-tapping'), 320)
  if (bpm > 0) {
    ui.tapHint.textContent = `本次打拍：${bpm.toFixed(1)} BPM`
    syncReadout()
  } else {
    ui.tapHint.textContent = '再点一次…'
  }
})

ui.reanalyze.addEventListener('click', () => {
  if (!beatgrid) return
  beatgrid.resetTap()
  beatgrid.analyze()
  detectedOffset = beatgrid.getGrid().offset
  phaseOffset = 0
  ui.phase.value = '0'
  ui.phaseOut.textContent = '0 ms'
  ui.tapHint.textContent = '连续点击 2 次以上，取平均间隔。'
  syncReadout()
})

ui.reset.addEventListener('click', () => {
  if (!beatgrid) return
  beatgrid.setBpm(120)
  beatgrid.setOffset(0)
  beatgrid.setLoop(null)
  detectedOffset = 0
  phaseOffset = 0
  ui.phase.value = '0'
  ui.phaseOut.textContent = '0 ms'
  syncReadout()
})

const loopCurrent = () => {
  if (!beatgrid) return
  const grid = beatgrid.getGrid()
  if (grid.beatInterval <= 0) return
  const barLength = grid.beatInterval * (grid.beatsPerBar || 4)
  const bars = Number(ui.loopBars.value)
  const rawStart = beatgrid.barStartAt(wavesurfer.getCurrentTime())
  // Clamp FIRST, then derive the end from the clamped start. Deriving the end
  // from the raw start produced a 0.03 s "loop" whenever the playhead sat in
  // the partial bar before the first detected beat (rawStart was negative).
  const start = Math.max(0, rawStart)
  beatgrid.setLoop({ start, end: start + barLength * bars })
}

ui.loopBar.addEventListener('click', loopCurrent)
ui.loopClear.addEventListener('click', () => beatgrid?.setLoop(null))

// ── Keyboard ──────────────────────────────────────────────────────────────

document.addEventListener('keydown', (event) => {
  const target = event.target
  const isFormField = target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)

  if (event.code === 'Space' && !isFormField) {
    event.preventDefault()
    void wavesurfer?.playPause()
    return
  }
  if (isFormField) return

  if (event.key === 'l' || event.key === 'L') {
    event.preventDefault()
    loopCurrent()
  } else if (event.key === 't' || event.key === 'T') {
    event.preventDefault()
    ui.tap.click()
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    phaseOffset += direction * 0.01
    ui.phase.value = String(Math.round(phaseOffset * 1000))
    applyPhase()
  }
})

// ── Boot ──────────────────────────────────────────────────────────────────

renderTracks()
ui.sensOut.textContent = Number(ui.sensitivity.value).toFixed(2)
await loadTrack(TRACKS[0])

// Expose a tiny hook so the verification script can assert on real state
// without scraping the DOM.
window.__beatgridDemo = {
  getState: () => {
    const grid = beatgrid?.getGrid()
    return {
      bpm: grid?.bpm ?? 0,
      confidence: grid?.confidence ?? 0,
      beatInterval: grid?.beatInterval ?? 0,
      offset: grid?.offset ?? 0,
      onsets: beatgrid?.getOnsets().length ?? 0,
      lines: beatgrid?.getRenderedLineCount() ?? 0,
      looping: beatgrid?.isLooping() ?? false,
      truth: currentTrack?.bpm ?? 0,
      playing: wavesurfer?.isPlaying() ?? false,
    }
  },
  play: () => wavesurfer?.play(),
  pause: () => wavesurfer?.pause(),
  seek: (time) => wavesurfer?.setTime(time),
  loopCurrent,
  analyze: () => beatgrid?.analyze(),
  setBpm: (bpm) => {
    beatgrid?.setBpm(bpm)
    syncReadout()
  },
}
