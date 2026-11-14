/**
 * 分流生命周期实验域验收脚本（Node 环境，内存态运行，不触碰浏览器 localStorage）。
 * 用 esbuild 把 @ 别名打包后执行：node scripts/run-verify.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'scripts', 'verify-abtest.ts')
const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  alias: { '@': path.join(root, 'src') },
})
const code = result.outputFiles[0].text
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
await mod.run({ assert })
