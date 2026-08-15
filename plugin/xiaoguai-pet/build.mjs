// 小乖插件构建脚本：host ESM + client __ModuleLoader__ IIFE
// 用法: node build.mjs
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

mkdirSync('lib', { recursive: true })

// 1) host 半区：普通 ESM（node 侧，@deepseek-ai/* 保持 external 由 profile 解析）
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'lib/index.js',
  external: ['@deepseek-ai/*', 'cordis', 'schemastery'],
})

// 2) client 半区：CJS，包进 window.__ModuleLoader__.load 工厂（与 dsh 官方 loader 约定一致）
const cjsResult = await build({
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  write: false,
  external: ['react', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
})
const cjs = cjsResult.outputFiles[0].text
const final = `window.__ModuleLoader__.load({
\tid: "dsh-xiaoguai-pet",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${cjs}
\t\treturn module.exports;
\t}
});
`
await writeFile('lib/client.js', final, 'utf8')
console.log('built lib/index.js + lib/client.js')

