import path from 'node:path'
import { glob } from 'glob'
import typescript from '@rollup/plugin-typescript'
import terser from '@rollup/plugin-terser'
import webWorkerLoader from 'rollup-plugin-web-worker-loader'

const plugins = [
  webWorkerLoader(),
  typescript({ declaration: false, declarationDir: null }),
  terser({ format: { comments: false } }),
]

// glob() returns platform-native separators, so on Windows every entry below
// came back with backslashes (src<sep>plugins<sep>foo.ts). The subsequent
// `.replace('src/', 'dist/')` calls then matched nothing, output paths stayed
// inside src/, and rollup aborted with "Path of Typescript compiler option
// 'outDir' must be located inside the same directory as the Rollup 'file'
// option" -- i.e. `npm run build` was broken on Windows for every plugin.
// Normalising to forward slashes here fixes all downstream replaces at once.
const pluginEntries = glob.sync('src/plugins/*.ts').map((entry) => entry.split(path.sep).join('/'))

export default [
  // ES module
  {
    input: 'src/wavesurfer.ts',
    output: {
      file: 'dist/wavesurfer.esm.js',
      format: 'esm',
    },
    plugins,
  },
  // CommonJS module (Node.js)
  {
    input: 'src/wavesurfer.ts',
    output: {
      file: 'dist/wavesurfer.cjs',
      format: 'cjs',
      exports: 'default',
    },
    plugins,
  },
  // UMD (browser script tag)
  {
    input: 'src/wavesurfer.ts',
    output: {
      name: 'WaveSurfer',
      file: 'dist/wavesurfer.min.js',
      format: 'umd',
      exports: 'default',
    },
    plugins,
  },

  // Wavesurfer plugins (exclude worker files)
  ...pluginEntries
    .filter((plugin) => !plugin.includes('worker'))
    .map((plugin) => [
      // ES module
      {
        input: plugin,
        output: {
          file: plugin.replace('src/', 'dist/').replace('.ts', '.js'),
          format: 'esm',
        },
        plugins,
      },
      // ES module again but with an .esm.js extension
      {
        input: plugin,
        output: {
          file: plugin.replace('src/', 'dist/').replace('.ts', '.esm.js'),
          format: 'esm',
        },
        plugins,
      },
      // CommonJS module (Node.js)
      {
        input: plugin,
        output: {
          name: plugin.replace('src/plugins/', '').replace('.ts', ''),
          file: plugin.replace('src/', 'dist/').replace('.ts', '.cjs'),
          format: 'cjs',
          exports: 'default',
        },
        plugins,
      },
      // UMD (browser script tag)
      {
        input: plugin,
        output: {
          name: plugin
            .replace('src/plugins/', '')
            .replace('.ts', '')
            .replace(/^./, (c) => `WaveSurfer.${c.toUpperCase()}`),
          file: plugin.replace('src/', 'dist/').replace('.ts', '.min.js'),
          format: 'umd',
          extend: true,
          globals: {
            WaveSurfer: 'WaveSurfer',
          },
          exports: 'default',
        },
        external: ['WaveSurfer'],
        plugins,
      },
    ])
    .flat(),
]
