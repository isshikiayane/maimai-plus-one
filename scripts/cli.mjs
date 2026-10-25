#!/usr/bin/env node
/**
 * 麦麦加一点 · CLI
 *
 * 用法：
 *   node scripts/cli.mjs stores --city 上海 --keyword 华旭
 *   node scripts/cli.mjs menu   --store 1450713
 *   node scripts/cli.mjs detail --store 1450713 --meal 9900005466
 *   node scripts/cli.mjs plan   --store 1450713 --meal 9900005466 --budget 5 --intent 咖啡
 *   node scripts/cli.mjs rank   --store 1450713 --meals 9900005466,9900005xxx
 *   node scripts/cli.mjs snapshot --store 1450713 --meals 9900005466 --out web/data.json
 *
 * 只读链路：本 CLI 永不调用 create-order / auto-bind-coupons / draw-lottery 等写操作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp.mjs';
import {
  parseDiffPrice,
  buildRoundList,
  summarizePrice,
  isBlockedPrice,
  attribute,
  filterByBudget,
  shortlistForPricing,
  sortCandidates,
  describeDelta,
  attributionLines,
  fenToYuan,
  fenToSigned,
} from './engine.mjs';
import { resolveIntent, detectUnsupported, enumerateCandidates, classifyRound, scoreCandidate } from './intent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');

const CTX = (storeCode) => ({ storeCode: String(storeCode), orderType: 1, beType: 1 });

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, flags, positional };
}

const nowIso = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = pad(Math.floor(Math.abs(off) / 60));
  const mm = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}${sign}${hh}:${mm}`;
};

const log = (...a) => console.error(...a);

// ---------- 数据访问 ----------
async function getStores(client, { city, keyword }) {
  const args = { beType: 1, searchType: city || keyword ? 2 : 1 };
  if (city) args.city = city;
  if (keyword) args.keyword = keyword;
  const res = await client.call('query-nearby-stores', args);
  const d = res?.data ?? res;
  const list = Array.isArray(d) ? d : d?.stores ?? d?.list ?? [];
  return list.map((s) => ({
    storeCode: String(s.storeCode),
    storeName: s.storeName,
    address: s.address,
    distance: s.distance,
    businessStatus: s.businessStatus,
  }));
}

async function getMenu(client, storeCode) {
  const res = await client.call('query-meals', CTX(storeCode));
  const d = res?.data ?? res;
  const meals = d?.meals ?? {};
  const categories = d?.categories ?? [];
  const items = [];
  for (const [code, m] of Object.entries(meals)) {
    items.push({
      code: String(code),
      name: m?.name,
      currentPriceFen: m?.currentPrice ?? null,
      originalPriceFen: m?.originalPrice ?? null,
      tags: m?.tags ?? [],
      canWithOrder: m?.canWithOrder ?? null,
      category: (categories.find((c) => (c.meals ?? []).some((x) => String(x.code) === String(code))) || {})
        .name,
    });
  }
  return { items, raw: d };
}

async function getDetail(client, storeCode, code) {
  const res = await client.call('query-meal-detail', { ...CTX(storeCode), code: String(code) });
  return res?.data ?? res;
}

async function getCoupons(client, storeCode) {
  try {
    const res = await client.call('query-store-coupons', CTX(storeCode));
    const d = res?.data ?? res;
    const list = Array.isArray(d) ? d : d?.coupons ?? d?.list ?? d?.couponList ?? [];
    return list
      .filter((c) => c && (c.couponId || c.couponCode))
      .map((c) => ({
        couponId: c.couponId ?? c.id,
        couponCode: c.couponCode ?? c.code,
        title: c.title ?? c.couponName ?? c.name ?? '',
        products: (c.products ?? []).map((p) => String(p.productCode ?? p.code ?? '')),
      }));
  } catch (err) {
    log('  ! 券查询失败，本次按无券核价：', err.message);
    return [];
  }
}

async function priceWith(client, storeCode, mealCode, roundList, coupon) {
  const item = { productCode: String(mealCode), quantity: 1 };
  if (roundList) item.roundList = roundList;
  if (coupon) {
    item.couponId = coupon.couponId;
    item.couponCode = coupon.couponCode;
  }
  const res = await client.call('calculate-price', {
    ...CTX(storeCode),
    items: [item],
    needTableware: false,
  });
  // 服务端业务失败（如 600012「促销规则不支持该商品」）必须显式返回，不能当成"无价格"
  const envelope = res && typeof res === 'object' ? res : {};
  if (envelope.success === false) {
    return { summary: null, error: { code: envelope.code, message: envelope.message } };
  }
  const summary = summarizePrice(res);
  if (!summary) return { summary: null, error: { code: 'NO_PRICE', message: '返回体不含价格字段' } };
  return { summary, error: null };
}

/** 某一侧取"更便宜的那个报价"，并记录是否用了券 */
function bestOf(plain, couponed) {
  const a = plain?.summary ? { summary: plain.summary, couponUsed: false } : null;
  const b = couponed?.summary ? { summary: couponed.summary, couponUsed: true } : null;
  if (!a && !b) return { summary: null, couponUsed: false };
  if (!a) return b;
  if (!b) return a;
  return b.summary.priceFen < a.summary.priceFen ? b : a;
}

// ---------- 主流程：plan ----------
async function runPlan(client, flags) {
  const storeCode = String(flags.store || '');
  const mealCode = String(flags.meal || '');
  const budgetFen = Math.round(Number(flags.budget ?? 5) * 100);
  const intentText = String(flags.intent || '咖啡');
  if (!storeCode || !mealCode) throw new Error('缺少 --store 或 --meal');

  const unsupported = detectUnsupported(intentText);
  if (unsupported?.mode === 'refuse') {
    return { refused: true, reason: unsupported.reason, intentText };
  }

  const detail = await getDetail(client, storeCode, mealCode);
  const rounds = detail?.rounds ?? [];
  if (!rounds.length) {
    return { noRounds: true, mealName: detail?.name, intentText };
  }

  // 基线：显式 roundList
  const { roundList: baseRoundList, notes: baseNotes } = buildRoundList(rounds);
  const basePriced = await priceWith(client, storeCode, mealCode, baseRoundList, null);
  if (!basePriced.summary || isBlockedPrice(basePriced.summary)) {
    return {
      blocked: true,
      mealName: detail?.name,
      reason: basePriced.error?.message ?? '该套餐需配合券购买，无法单独报价',
    };
  }
  const baseSummary = basePriced.summary;

  const probePriced = await priceWith(client, storeCode, mealCode, null, null);
  const baselineProbe = {
    explicitFen: baseSummary.priceFen,
    implicitFen: probePriced.summary?.priceFen ?? null,
    diffFen:
      probePriced.summary && probePriced.summary.priceFen !== baseSummary.priceFen
        ? probePriced.summary.priceFen - baseSummary.priceFen
        : 0,
  };

  const couponNotes = [];
  const coupons = await getCoupons(client, storeCode);
  const baseCoupon = pickCouponFor(coupons, mealCode, []);
  const baseCouponPriced = baseCoupon
    ? await priceWith(client, storeCode, mealCode, baseRoundList, baseCoupon)
    : null;
  if (baseCouponPriced?.error) {
    couponNotes.push(
      `门店券「${baseCoupon.title}」无法用于本套餐：服务端返回 ${baseCouponPriced.error.code} ${baseCouponPriced.error.message}`
    );
  }
  const baseBest = bestOf(basePriced, baseCouponPriced);

  const intent = resolveIntent(intentText);
  const unsupportedDegrade = unsupported?.mode === 'degrade';
  const { candidates: rawCands, notes: candNotes, fallback } = enumerateCandidates(
    rounds,
    intent ?? { id: 'all', label: '未识别', kinds: ['drink', 'side', 'main'], allow: null, deny: null, why: () => '按默认顺序' },
    { avoidCodes: String(flags.avoid || '').split(',').filter(Boolean), limit: 40 }
  );

  const shortlist = shortlistForPricing(rawCands, budgetFen, {
    couponBufferFen: baseBest.summary && baseCoupon ? baseBest.summary.absorbedFen : 0,
    limit: Number(flags.limit ?? 4),
  });

  const priced = [];
  const unverified = [];
  for (const cand of shortlist) {
    const { roundList } = buildRoundList(rounds, { [cand.roundId]: cand.to.code });
    const plain = await priceWith(client, storeCode, mealCode, roundList, null);
    if (!plain.summary) {
      unverified.push({ ...cand, reason: plain.error?.message ?? '报价失败' });
      continue;
    }
    if (isBlockedPrice(plain.summary)) {
      unverified.push({ ...cand, reason: '需配合券购买，无法单独报价' });
      continue;
    }
    const coupon = pickCouponFor(coupons, mealCode, [cand.to.code]);
    const couponed = coupon ? await priceWith(client, storeCode, mealCode, roundList, coupon) : null;
    if (couponed?.error && !couponNotes.some((n) => n.includes(String(couponed.error.code)))) {
      couponNotes.push(
        `券不能与套餐内替换叠加：服务端返回 ${couponed.error.code} ${couponed.error.message}（该券只对单点商品生效）`
      );
    }
    const best = bestOf(plain, couponed);

    const attr = attribute({
      base: baseSummary,
      cand: best.summary,
      menuDeltaFen: cand.menuDeltaFen,
      couponCoveredCodes: baseCoupon ? baseCoupon.products : [],
      changedCodes: [cand.from?.code, cand.to.code].filter(Boolean),
    });

    const scored = scoreCandidate(cand, { intentId: intent?.id ?? '' });
    priced.push({
      ...cand,
      priceFen: best.summary.priceFen,
      attribution: {
        ...attr,
        couponBroken:
          attr.couponBroken || (baseBest.couponUsed && !best.couponUsed && baseSummary.absorbedFen > 0),
      },
      couponUsed: best.couponUsed,
      couponTitle: best.couponUsed ? baseCoupon?.title || '门店券' : null,
      alternatives: {
        noCouponFen: plain.summary.priceFen,
        withCouponFen: couponed?.summary?.priceFen ?? null,
      },
      score: scored.score,
      why: `${cand.why}；${scored.why}`,
    });
  }

  const { eligible, overBudget, unpriced } = filterByBudget(priced, budgetFen);
  const ordered = sortCandidates(eligible);

  return {
    storeCode,
    mealCode,
    mealName: detail?.name,
    roundsMeta: rounds.map((r) => ({
      roundId: String(r.id),
      roundName: r.name,
      kind: classifyRound(r),
      choiceCount: (r.choices ?? []).length,
    })),
    budgetFen,
    intentText,
    intentLabel: intent?.label ?? '未识别意图',
    baseline: {
      roundList: baseRoundList,
      priceFen: baseBest.summary.priceFen,
      productPriceFen: baseBest.summary.productPriceFen,
      originalPriceFen: baseBest.summary.originalPriceFen,
      absorbedFen: baseBest.summary.absorbedFen,
      couponUsed: baseBest.couponUsed,
      couponTitle: baseBest.couponUsed ? baseCoupon?.title : null,
      probe: baselineProbe,
      notes: baseNotes,
    },
    couponContext: {
      storeCouponCount: coupons.length,
      candidateTitles: coupons.slice(0, 3).map((c) => c.title),
      notes: couponNotes,
    },
    best: ordered[0] ?? null,
    eligible: ordered,
    overBudget,
    unverified,
    unpriced,
    notes: [...baseNotes, ...candNotes],
    fallback: fallback || unsupportedDegrade,
    unsupportedReason: unsupported?.reason ?? null,
    capturedAt: nowIso(),
    audit: client.audit,
  };
}

function pickCouponFor(coupons, mealCode, extraCodes = []) {
  if (!coupons?.length) return null;
  const wanted = new Set([String(mealCode), ...extraCodes.map(String)]);
  return (
    coupons.find((c) => c.products.some((p) => wanted.has(String(p)))) ?? null
  );
}

// ---------- 输出渲染 ----------
function renderPlan(r) {
  const lines = [];
  const meta = (label) => `【${label}】`;

  if (r.refused) {
    return [
      `无法给出建议：${r.reason}`,
      '这属于"没有数据就不下结论"的情形，我不会用相近选项替代。',
    ].join('\n');
  }
  if (r.noRounds) return `「${r.mealName}」没有可替换的套餐子项，加不了。`;
  if (r.blocked) return `「${r.mealName}」${r.reason}。`;

  lines.push(`套餐：${r.mealName}（${r.mealCode}）  门店：${r.storeCode}`);
  lines.push(
    `原餐实付：${fenToYuan(r.baseline.priceFen)}${r.baseline.couponUsed ? `（含券：${r.baseline.couponTitle || '门店券'}，原价 ${fenToYuan(r.baseline.originalPriceFen)}）` : '（未用券）'}`
  );
  lines.push(`预算：最多再加 ${fenToYuan(r.budgetFen)}　目标：${r.intentLabel}`);
  if (r.unsupportedReason) lines.push(`注意：${r.unsupportedReason}`);
  lines.push('');

  if (!r.eligible.length) {
    lines.push(`按你的预算和目标，这家店这个套餐里没有符合条件的替换项。`);
    if (r.overBudget.length) {
      lines.push('最接近的（均超出预算）：');
      for (const c of r.overBudget) {
        lines.push(
          `  · ${c.roundName}：${c.from?.name} → ${c.to.name}　实付${fenToSigned(c.attribution.deltaFen)}（超预算 ${fenToYuan(c.attribution.deltaFen - r.budgetFen)}）`
        );
      }
    }
    if (r.unverified.length) lines.push(`另有 ${r.unverified.length} 项需配合券购买，无法单独报价。`);
    lines.push('');
    lines.push(dataLine(r));
    return lines.join('\n');
  }

  r.eligible.forEach((c, idx) => {
    const a = c.attribution;
    lines.push(`${idx === 0 ? '★ ' : '  '}${c.roundName}：${c.from?.name ?? '—'} → ${c.to.name}`);
    lines.push(`  ${meta('真实多花')}${describeDelta(a)}　（实付 ${fenToYuan(c.priceFen)}）`);
    for (const l of attributionLines(a)) {
      lines.push(`    ├ ${l.label}：${l.value}${l.note ? `（${l.note}）` : ''}`);
    }
    if (a.couponBroken) {
      lines.push(`    ⚠ 这项会换掉券绑定的商品，原券可能失效，请以结算页为准`);
    }
    if (a.level === 'degraded') {
      lines.push(`    ! 本次计价与菜单补差差异过大，不做拆解，只展示实付差额`);
    }
    lines.push(`  ${meta('为什么是它')}${c.why}`);
    lines.push('');
  });

  if (r.overBudget.length) {
    lines.push('预算外还有（仅供参考，不会自动推荐）：');
    for (const c of r.overBudget) {
      lines.push(
        `  · ${c.roundName}：${c.from?.name ?? '—'} → ${c.to.name}　实付${fenToSigned(c.attribution.deltaFen)}（超预算 ${fenToYuan(c.attribution.deltaFen - r.budgetFen)}）`
      );
    }
    lines.push('');
  }

  if (r.couponContext?.notes?.length) {
    lines.push('关于券（来自服务端实际返回，不是推测）：');
    for (const n of r.couponContext.notes) lines.push(`  · ${n}`);
    lines.push('');
  }
  if (r.unverified.length) lines.push(`另有 ${r.unverified.length} 项需配合券购买，无法单独报价（未计入对比）。`);
  if (r.notes.length) lines.push(`备注：${r.notes.join('；')}。`);
  lines.push(dataLine(r));
  return lines.join('\n');
}

function dataLine(r) {
  const usedCoupon = r.baseline.couponUsed || r.eligible.some((c) => c.couponUsed);
  return `【数据】门店 ${r.storeCode} · 抓取 ${r.capturedAt} · 到店自取 · ${usedCoupon ? '已纳入门店可用券' : '未含券'} · 金额以门店结算为准`;
}

// ---------- 加价榜 ----------
async function runRank(client, flags) {
  const storeCode = String(flags.store || '');
  const menu = await getMenu(client, storeCode);
  const wanted = String(flags.meals || '')
    .split(',')
    .filter(Boolean);
  const comboCandidates = menu.items
    .filter((m) => (wanted.length ? wanted.includes(m.code) : /套餐|三件套|双人餐|单人餐/.test(m.name ?? '')))
    .slice(0, Number(flags.maxMeals ?? 3));

  const details = [];
  for (const meal of comboCandidates) {
    try {
      const detail = await getDetail(client, storeCode, meal.code);
      if ((detail?.rounds ?? []).length) details.push({ meal, detail });
    } catch (err) {
      log(`  ! 跳过 ${meal.name}：${err.message}`);
    }
  }

  const buckets = { drop: [], one: [], three: [], five: [] };
  const all = [];
  for (const { meal, detail } of details) {
    for (const round of detail.rounds ?? []) {
      const kind = classifyRound(round);
      for (const c of round.choices ?? []) {
        const parsed = parseDiffPrice(c.diffPrice);
        if (!parsed.ok) continue;
        if (c.isDefault === 1) continue;
        const entry = {
          mealCode: meal.code,
          mealName: detail.name ?? meal.name,
          roundId: String(round.id),
          roundName: round.name,
          roundKind: kind,
          choiceCode: String(c.code),
          choiceName: c.name,
          diffPriceFen: parsed.fen,
          diffPriceRaw: c.diffPrice,
        };
        all.push(entry);
        if (parsed.fen < 0) buckets.drop.push(entry);
        else if (parsed.fen <= 100) buckets.one.push(entry);
        else if (parsed.fen <= 300) buckets.three.push(entry);
        else if (parsed.fen <= 500) buckets.five.push(entry);
      }
    }
  }

  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => a.diffPriceFen - b.diffPriceFen);
  }
  return { storeCode, generatedAt: nowIso(), meals: details.map((d) => d.meal), buckets, total: all.length };
}

// ---------- 快照 ----------
async function runSnapshot(client, flags) {
  const storeCode = String(flags.store || '');
  const out = String(flags.out || 'web/data.json');
  const menus = await getMenu(client, storeCode);
  const wanted = String(flags.meals || '')
    .split(',')
    .filter(Boolean);
  const combos = menus.items
    .filter((m) =>
      wanted.length ? wanted.includes(m.code) : /三件套|套餐/.test(m.name ?? '')
    )
    .slice(0, Number(flags.maxMeals ?? 3));
  const intents = String(flags.intents || flags.intent || '咖啡')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const built = [];
  for (const meal of combos) {
    for (const intentText of intents) {
      try {
        const plan = await runPlan(client, {
          store: storeCode,
          meal: meal.code,
          budget: flags.budget ?? 5,
          intent: intentText,
          limit: flags.limit ?? 4,
        });
        if (plan.eligible || plan.overBudget || plan.noRounds) {
          built.push({ ...plan, intentRequested: intentText });
        }
      } catch (err) {
        log(`  ! 跳过 ${meal.name} / ${intentText}：${err.message}`);
      }
    }
  }

  const rank = await runRank(client, { store: storeCode, meals: combos.map((c) => c.code).join(',') });

  const snapshot = {
    schemaVersion: '1.0.0',
    generatedAt: nowIso(),
    generator: { name: 'maimai-plus-one', mode: 'snapshot' },
    channel: { orderType: 1, beType: 1, beCode: null, label: '到店自取' },
    store: { storeCode, storeName: flags.storeName || menus.items[0]?.storeName || '', city: flags.city || '' },
    plans: built,
    leaderboard: rank,
    audit: client.audit,
    disclaimers: DISCLAIMERS,
  };

  const target = path.isAbsolute(out) ? out : path.join(ROOT, out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(snapshot, null, 2), 'utf8');
  log(`快照已写入 ${target}（${client.audit.length} 次调用）`);
  return snapshot;
}

const DISCLAIMERS = [
  '价格来自麦当劳中国 MCP 实时抓取，抓取时间见 generatedAt；菜单与价格可能随时调整。',
  '「菜单补差」为套餐内选项的公示差价，不等同于实付差额；实付以 calculate-price 与门店结算为准。',
  '本页未包含你账户内可能存在的全部券，实际支付可能更低。',
  '不同套餐基础配置不同，加价额仅在该套餐内部可比，本榜不提供跨套餐排名。',
  '本榜只列麦当劳自家商品，不与任何其他品牌做对比。',
];

// ---------- 入口 ----------
async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help') {
    console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0].replace('/**', ''));
    return;
  }

  const client = new McpClient({ budget: Number(flags.budgetCalls ?? 40) });
  if (!client.hasToken) {
    console.error('缺少 MCD_MCP_TOKEN 环境变量。请在 open.mcd.cn/mcp 申请后设置：');
    console.error('  export MCD_MCP_TOKEN=你的令牌');
    process.exitCode = 2;
    return;
  }

  switch (command) {
    case 'stores': {
      const list = await getStores(client, { city: flags.city, keyword: flags.keyword });
      for (const s of list) console.log(`${s.storeCode}  ${s.storeName}  ${s.address ?? ''}`);
      break;
    }
    case 'menu': {
      const { items } = await getMenu(client, flags.store);
      for (const m of items.slice(0, Number(flags.limit ?? 40))) {
        console.log(`${m.code}  ${String(m.name).padEnd(24, ' ')} ${fenToYuan(m.currentPriceFen)}  ${m.category ?? ''}`);
      }
      break;
    }
    case 'detail': {
      const d = await getDetail(client, flags.store, flags.meal);
      console.log(`${d.name}（${d.code}）`);
      for (const r of d.rounds ?? []) {
        console.log(`  第 ${r.id} 轮 ${r.name}（${classifyRound(r)}）`);
        for (const c of r.choices ?? []) {
          console.log(`    ${c.isDefault === 1 ? '*' : ' '} ${c.code} ${c.name} ${c.diffPrice}`);
        }
      }
      break;
    }
    case 'plan': {
      const r = await runPlan(client, flags);
      if (flags.json) console.log(JSON.stringify(r, null, 2));
      else console.log(renderPlan(r));
      if (!flags.json) {
        console.error(`\n[调用 ${client.calls} 次 / 审计 ${client.audit.length} 条]`);
      }
      break;
    }
    case 'rank': {
      const r = await runRank(client, flags);
      console.log(`加价榜　门店 ${r.storeCode}　${r.generatedAt}`);
      console.log(`覆盖 ${r.meals.length} 个套餐，共 ${r.total} 个替换项\n`);
      for (const [key, label] of [
        ['drop', '不加反降'],
        ['one', '¥1 以内'],
        ['three', '¥1–3'],
        ['five', '¥3–5'],
      ]) {
        console.log(`— ${label}（${r.buckets[key].length} 项）`);
        for (const e of r.buckets[key].slice(0, Number(flags.show ?? 8))) {
          console.log(`   ${fenToSigned(e.diffPriceFen).padEnd(8)} ${e.choiceName}　[${e.mealName} · ${e.roundName}]`);
        }
      }
      break;
    }
    case 'snapshot': {
      await runSnapshot(client, flags);
      break;
    }
    default:
      console.error(`未知命令：${command}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('执行失败：', err?.message || err);
  if (err?.status === 401) console.error('提示：令牌无效或已过期，请在 open.mcd.cn/mcp 重新激活。');
  if (err?.status === 429) console.error('提示：触发限流（600/min），请稍后重试。');
  process.exitCode = 1;
});
