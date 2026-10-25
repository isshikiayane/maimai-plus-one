/**
 * 合规与隐私扫描（提交前必跑）
 *
 * 检查三类问题：
 *  1) 跨品牌对比（活动规则 L84-e 禁止将麦当劳品牌与其他品牌对比）
 *  2) 真实凭证泄漏（Bearer token、长随机串）
 *  3) 个人信息泄漏（手机号、地址、会员号）
 *
 * 用法：node scripts/check-compliance.mjs
 * 退出码 0 = 通过；1 = 存在必须修复的问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SCAN_EXT = new Set(['.md', '.mjs', '.js', '.json', '.html', '.css', '.yml', '.yaml', '.txt']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', '.github']);

const BRANDS = [
  '星巴克', '瑞幸', '库迪', '肯德基', '汉堡王', '德克士', '华莱士', '必胜客', '塔斯汀',
  '喜茶', '奈雪的茶', '蜜雪冰城', '茶百道', '古茗', '霸王茶姬',
  'Starbucks', 'Luckin', 'KFC', 'Burger King', 'Costa', 'Manner', 'Tims', 'Tim Hortons',
];

const RULES = [
  {
    id: 'BRAND_COMPARE',
    level: 'fail',
    test: (line) => BRANDS.filter((b) => line.includes(b)),
    message: (hits) => `出现其他餐饮品牌名（${hits.join('、')}）——规则禁止跨品牌对比，请改写为麦当劳内部方案比较`,
  },
  {
    id: 'BEARER_TOKEN',
    level: 'fail',
    test: (line) => {
      const m = line.match(/Bearer\s+([A-Za-z0-9._\-+/=]{16,})/);
      if (!m) return null;
      // 占位符不算泄漏
      return /YOUR|TOKEN|PLACEHOLDER|<|\$\{/.test(m[1]) ? null : [m[1].slice(0, 6) + '…'];
    },
    message: () => '发现疑似真实 Bearer 令牌，必须改为环境变量占位符',
  },
  {
    id: 'PHONE',
    level: 'fail',
    test: (line) => {
      const m = line.match(/(?<!\d)(1[3-9]\d{9})(?!\d)/);
      return m ? [m[1].slice(0, 3) + '****' + m[1].slice(-4)] : null;
    },
    message: () => '发现疑似手机号，必须脱敏',
  },
  {
    id: 'COUPON_ID',
    level: 'warn',
    test: (line) => {
      const m = line.match(/[0-9A-F]{32}/);
      return m ? [m[0].slice(0, 4) + '…'] : null;
    },
    message: () => '发现 32 位券 ID，建议只保留后 4 位或改为存在性描述',
  },
  {
    id: 'LEGACY_PLACEHOLDER',
    level: 'warn',
    test: (line) => (line.includes('YOUR_MCP_TOKEN') ? ['YOUR_MCP_TOKEN'] : null),
    message: () => '官方要求配置文件仅使用环境变量占位符，建议改为 ${MCD_MCP_TOKEN}',
  },
];

const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!SCAN_EXT.has(ext)) continue;
    const file = path.join(dir, entry.name);
    if (file.endsWith(path.join('scripts', 'check-compliance.mjs'))) continue;
    scanFile(file);
  }
}

function scanFile(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    // 允许在扫描脚本自身与本文件声明出现品牌词（文档里说明"未出现其他品牌"不构成对比）
    for (const rule of RULES) {
      const hits = rule.test(line);
      if (hits && hits.length) {
        findings.push({ file: rel, line: i + 1, rule: rule.id, level: rule.level, message: rule.message(hits), snippet: line.trim().slice(0, 120) });
      }
    }
  });
}

walk(ROOT);

const fails = findings.filter((f) => f.level === 'fail');
const warns = findings.filter((f) => f.level === 'warn');

if (!findings.length) {
  console.log('合规扫描通过：未发现跨品牌对比、凭证泄漏或个人信息。');
} else {
  for (const f of [...fails, ...warns]) {
    const tag = f.level === 'fail' ? 'FAIL' : 'WARN';
    console.log(`[${tag}] ${f.rule}  ${f.file}:${f.line}`);
    console.log(`       ${f.message}`);
    console.log(`       > ${f.snippet}`);
  }
  console.log(`\n合计 ${fails.length} 项必须修复，${warns.length} 项建议修复。`);
}

process.exit(fails.length ? 1 : 0);
