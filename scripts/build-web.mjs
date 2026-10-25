/**
 * 把 style.css / app.js / data.json 内联进一个自包含的 index.html。
 *
 * 为什么必须内联：Chrome 在 file:// 协议下会以 Origin: null 拦截 fetch('./data.json')，
 * 页面只有零网络请求才能在本地双击打开、也才能作为分享 artifact 直接分发。
 *
 * 用法：node scripts/build-web.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');

const read = (p) => fs.readFileSync(p, 'utf8');

const template = read(path.join(WEB, 'template.html'));
const style = read(path.join(WEB, 'style.css'));
const app = read(path.join(WEB, 'app.js'));
const dataPath = path.join(WEB, 'data.json');

if (!fs.existsSync(dataPath)) {
  console.error('缺少 web/data.json，请先运行：node scripts/cli.mjs snapshot --store <店码>');
  process.exit(1);
}
const data = read(dataPath);

// JSON 内联到 <script> 时必须打断 </script> 与 <!-- 序列
const safeJson = data.replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');

const out = template
  .replace('/*__STYLE__*/', () => style)
  .replace('/*__APP__*/', () => app)
  .replace('/*__DATA__*/', () => safeJson);

const target = path.join(WEB, 'index.html');
fs.writeFileSync(target, out, 'utf8');

// GitHub Pages 只支持从仓库根目录或 /docs 发布，这里同步一份到 docs/
const docsDir = path.join(ROOT, 'docs');
fs.mkdirSync(docsDir, { recursive: true });
const docsTarget = path.join(docsDir, 'index.html');
fs.writeFileSync(docsTarget, out, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`已生成 ${target}`);
console.log(`已生成 ${docsTarget}（GitHub Pages 入口，仓库设置里选 /docs 即可）`);
console.log(`  style ${kb(style.length)}  app ${kb(app.length)}  data ${kb(data.length)}  合计 ${kb(out.length)}`);
