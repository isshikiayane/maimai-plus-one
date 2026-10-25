/**
 * 探针脚本（开发期使用，也可作为赛事要求的"通道自检"）
 * 用途：把真实响应原始落盘到 .cache/，只打印结构摘要，便于锁定字段名与检测协议漂移。
 *
 * 用法：
 *   MCD_MCP_TOKEN=xxx node scripts/probe.mjs <storeCode> <mealCode> [city] [keyword]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');

const [, , storeCodeArg, mealCodeArg] = process.argv;
const storeCode = storeCodeArg || '1450713';
const mealCode = mealCodeArg || '9900005466';

const ctx = { storeCode, orderType: 1, beType: 1 };

function shape(v, depth = 0, maxDepth = 2) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (depth >= maxDepth) return `[${v.length} items]`;
    return `[${shape(v[0], depth + 1, maxDepth)} ×${v.length}]`;
  }
  if (typeof v === 'object') {
    if (depth >= maxDepth) return '{…}';
    return (
      '{' +
      Object.entries(v)
        .map(([k, val]) => `${k}: ${shape(val, depth + 1, maxDepth)}`)
        .join(', ') +
      '}'
    );
  }
  return typeof v === 'string' ? `"${v.slice(0, 40)}"` : String(v);
}

function save(name, obj) {
  fs.mkdirSync(CACHE, { recursive: true });
  const p = path.join(CACHE, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
}

const client = new McpClient({ budget: 20 });

console.log('== token present:', client.hasToken);
console.log('== endpoint:', client.endpoint);

const detail = await client.call('query-meal-detail', { ...ctx, code: mealCode });
const detailPath = save('detail.json', detail);
const d = detail?.data ?? detail;
console.log('\n== query-meal-detail →', detailPath);
console.log('top keys:', Object.keys(detail || {}).join(','));
console.log('data keys:', Object.keys(d || {}).join(','));
if (Array.isArray(d?.rounds)) {
  console.log('rounds:', d.rounds.length);
  for (const r of d.rounds) {
    console.log(
      `  round id=${JSON.stringify(r.id)} name=${r.name} qty=${r.quantity} min=${r.minQuantity} max=${r.maxQuantity} choices=${(r.choices || []).length}`
    );
    for (const c of (r.choices || []).slice(0, 6)) {
      console.log(
        `      [${c.isDefault ? 'D' : ' '}] ${c.code} ${c.name} diff=${JSON.stringify(c.diffPrice)}`
      );
    }
  }
}

const base = await client.call('calculate-price', {
  ...ctx,
  items: [{ productCode: mealCode, quantity: 1 }],
  needTableware: false,
});
const basePath = save('base.json', base);
console.log('\n== calculate-price (no roundList) →', basePath);
console.log('shape:', shape(base, 0, 3));

const baseD = base?.data ?? base;
console.log('\n== 关键字段：');
for (const k of Object.keys(baseD || {})) {
  const v = baseD[k];
  const printable =
    v === null || ['string', 'number', 'boolean'].includes(typeof v) ? JSON.stringify(v) : shape(v);
  console.log(`  ${k} = ${printable}`);
}

console.log('\n== audit:');
for (const a of client.audit) {
  console.log(`  #${a.seq} ${a.tool} ${a.ms}ms ${a.status} ${JSON.stringify(a.result)}`);
}
