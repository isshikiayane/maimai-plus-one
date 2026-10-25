/**
 * 意图 → 候选映射
 *
 * 原则：
 *  1) deny 优先于 allow（"咖啡味冰淇淋"必须先被剔除）
 *  2) 无法可靠映射的意图一律降级为"让用户自己挑"，绝不用"相近"塞答案
 *  3) 每个候选都要能打印"为什么是它"，禁止只给分数
 */
import { parseDiffPrice } from './engine.mjs';

const ROUND_KIND_RULES = [
  { kind: 'drink', test: /饮料|饮品|可乐|雪碧|咖啡|奶昔|茶|果汁/ },
  { kind: 'side', test: /小食|薯条|鸡块|玉米|鸡翅|洋葱圈|派/ },
  { kind: 'main', test: /汉堡|巨无霸|主食|牛堡|鸡堡/ },
];

/** 依据轮次名称与选项名称给轮次打标 */
export function classifyRound(round) {
  const hay = `${round?.name ?? ''} ${(round?.choices ?? []).map((c) => c.name).join(' ')}`;
  for (const rule of ROUND_KIND_RULES) {
    if (rule.test.test(hay)) return rule.kind;
  }
  return 'unknown';
}

/** 可稳定支持的意图（其余一律走降级话术） */
export const INTENTS = {
  coffee: {
    id: 'coffee',
    label: '想喝咖啡',
    kinds: ['drink'],
    allow: /咖啡|美式|拿铁|卡布奇诺|摩卡|澳白|浓缩|冷萃|鲜萃|espresso|mccaf/i,
    deny: /圣代|麦旋风|雪冰|蛋糕|饼干|咖啡味|咖啡风味(?!.*奶昔)/i,
    why: (c) => `名称命中「${matchWord(c.name, /咖啡|美式|拿铁|卡布奇诺|摩卡|澳白|浓缩|冷萃|鲜萃/) ?? '咖啡' }」`,
  },
  lessSugar: {
    id: 'lessSugar',
    label: '想少糖',
    kinds: ['drink'],
    allow: /无糖|零度|0糖|纯净水|矿泉水|纯牛奶|美式|茶/,
    deny: /奶昔|雪冰|圣代|麦旋风|果汁|焦糖|香草|摩卡|拿铁|甜/,
    why: (c) => `名称命中「${matchWord(c.name, /无糖|零度|0糖|纯净水|矿泉水|纯牛奶|美式/) ?? '低糖' }」`,
  },
  fuller: {
    id: 'fuller',
    label: '想更饱',
    kinds: ['side', 'main', 'drink'],
    allow: /大薯|大杯|加大|双|巨|鸡块|块/,
    deny: /小杯|小薯|迷你|儿童|轻/,
    why: (c) => `份量更大：${matchWord(c.name, /大|双|巨|加大|块/) ?? '加量'}`,
  },
  side: {
    id: 'side',
    label: '想换小食',
    kinds: ['side'],
    allow: null,
    deny: null,
    why: () => '同轮小食替换',
  },
};

/** 明确无法用接口数据可靠支撑的意图 → 必须硬降级或硬拒绝 */
export const UNSUPPORTED_INTENTS = [
  { test: /过敏|清真|素食|无麸质|乳糖不耐/, mode: 'refuse', reason: '接口不提供过敏原与配方数据，无法给出安全结论。' },
  { test: /低卡|减脂|减肥|健身|热量控制/, mode: 'degrade', reason: '份量与做法不可知，只能展示同轮全部选项，不做推荐。' },
  { test: /健康|不油炸|清淡/, mode: 'refuse', reason: '接口无烹饪方式标签，无法判断。' },
  { test: /新品|限定|联名|上新/, mode: 'degrade', reason: '套餐内的替换项没有上新标签，只能全量列出由你挑选。' },
  { test: /小孩|儿童|长辈|老人|两人|分享/, mode: 'degrade', reason: '接口无人群与份量标签，只能全量列出由你挑选。' },
];

export function detectUnsupported(intentText = '') {
  for (const rule of UNSUPPORTED_INTENTS) {
    if (rule.test.test(intentText)) return rule;
  }
  return null;
}

export function resolveIntent(intentText = '') {
  const t = String(intentText);
  if (/咖啡/.test(t)) return INTENTS.coffee;
  if (/少糖|控糖|不甜|无糖/.test(t)) return INTENTS.lessSugar;
  if (/饱|量大|加量|吃多点/.test(t)) return INTENTS.fuller;
  if (/小食|换个小吃|薯条|鸡块/.test(t)) return INTENTS.side;
  return null;
}

/**
 * 枚举候选：只替换一轮，其余轮次保持默认
 * @returns {{candidates:Array, notes:string[], fallback:boolean}}
 */
export function enumerateCandidates(rounds, intent, { avoidCodes = [], limit = 6 } = {}) {
  const notes = [];
  const out = [];
  if (!intent) return { candidates: out, notes: ['无法识别意图'], fallback: true };

  const scopeRounds = (rounds ?? []).filter((r) => intent.kinds.includes(classifyRound(r)));
  if (!scopeRounds.length) {
    return { candidates: out, notes: ['没有与意图匹配的轮次'], fallback: true };
  }

  for (const round of scopeRounds) {
    const { choice: current } = pickDefault(round);
    const seen = new Set();
    for (const c of round.choices ?? []) {
      if (current && String(c.code) === String(current.code)) continue;
      if (avoidCodes.map(String).includes(String(c.code))) continue;
      if (seen.has(String(c.code))) continue;
      if (Number(c.maxQuantity) === 0) continue;
      if (intent.deny && intent.deny.test(c.name)) continue;
      if (intent.allow && !intent.allow.test(c.name)) continue;
      seen.add(String(c.code));
      const parsed = parseDiffPrice(c.diffPrice);
      if (!parsed.ok) {
        notes.push(`「${c.name}」的补差价无法解析（${c.diffPrice}），已跳过`);
        continue;
      }
      out.push({
        roundId: String(round.id),
        roundName: round.name,
        roundKind: classifyRound(round),
        from: current ? { code: String(current.code), name: current.name } : null,
        to: { code: String(c.code), name: c.name, diffPriceRaw: c.diffPrice },
        menuDeltaFen: parsed.fen,
        why: intent.why(c),
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return { candidates: out, notes, fallback: false };
}

function pickDefault(round) {
  const choices = round?.choices ?? [];
  const d = choices.find((c) => c.isDefault === 1 || c.isDefault === true);
  if (d) return { choice: d };
  const zero = choices.find((c) => parseDiffPrice(c.diffPrice).fen === 0);
  return { choice: zero ?? choices[0] ?? null };
}

function matchWord(text, re) {
  const m = String(text ?? '').match(re);
  return m ? m[0] : null;
}

/** 可解释评分（打印给用户，不是黑箱） */
export function scoreCandidate(cand, { nutrition = null, intentId = '' } = {}) {
  const parts = [];
  let score = 1.0;
  parts.push('意图命中 +1.0');

  const absExtra = Math.max(0, cand.menuDeltaFen) / 100;
  if (absExtra <= 0.01) {
    score += 0.5;
    parts.push('零加价 +0.5');
  } else {
    const cheapness = Math.max(0, 0.5 - absExtra / 40);
    score += cheapness;
    parts.push(`加价 ${absExtra.toFixed(2)} 元 ${cheapness >= 0 ? '+' : ''}${cheapness.toFixed(2)}`);
  }

  if (nutrition?.energyKcal) {
    const perYuan = absExtra > 0.01 ? nutrition.energyKcal / absExtra : Infinity;
    if (intentId === 'fuller') {
      const bonus = Math.min(1, perYuan / 400);
      score += bonus;
      parts.push(`每多花 1 元多 ${Math.round(perYuan)} kcal +${bonus.toFixed(2)}`);
    } else if (intentId === 'lessSugar' && nutrition.sugarG !== undefined) {
      const bonus = Math.max(0, 0.5 - nutrition.sugarG / 100);
      score += bonus;
      parts.push(`糖 ${nutrition.sugarG}g +${bonus.toFixed(2)}`);
    }
  }
  return { score: Number(score.toFixed(3)), why: parts.join('；'), nutrition };
}
