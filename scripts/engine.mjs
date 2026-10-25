/**
 * 归因引擎（纯函数，无 IO，可单测）
 *
 * 口径（全项目统一，不得改写）：
 *   P  = calculate-price.price           实付总价
 *   PR = calculate-price.productPrice    商品价（券后）
 *   OR = calculate-price.productOriginalPrice  商品原价
 *   A  = OR - PR                         优惠吸收总额（券 + 套餐自身优惠，不可再拆）
 *   G  = P - PR                          其它费用（到店通常 0）
 *   d  = choices[].diffPrice             套餐内选项的公示补差
 *
 * 一级恒等式： ΔP = ΔM_obs − ΔA + ΔG      （残差恒为 0，保证加得平）
 * 二级解释层： ε = ΔP − (ΔM_menu − ΔA + ΔG) （只用于"未归因差额"提示）
 */

const YUAN_PER_FEN = 100;

/** 解析 diffPrice 字符串；失败必须标记，禁止当 0 处理 */
export function parseDiffPrice(raw) {
  if (typeof raw !== 'string') return { fen: null, ok: false, raw: String(raw ?? '') };
  const compact = raw.replace(/\s+/g, '');
  const m = compact.match(/^([+-])¥([\d.]+)$/);
  if (!m) return { fen: null, ok: false, raw };
  const value = Number.parseFloat(m[2]);
  if (!Number.isFinite(value)) return { fen: null, ok: false, raw };
  const fen = Math.round(value * YUAN_PER_FEN);
  return { fen: m[1] === '-' ? -fen : fen, ok: true, raw };
}

export function fenToYuan(fen) {
  if (fen === null || fen === undefined || Number.isNaN(fen)) return '—';
  const sign = fen < 0 ? '-' : '';
  const abs = Math.abs(fen);
  return `${sign}¥${(abs / YUAN_PER_FEN).toFixed(2)}`;
}

/** 带符号展示，仅用于"多花/少花"这类方向明确的字段 */
export function fenToSigned(fen) {
  if (fen === null || fen === undefined || Number.isNaN(fen)) return '—';
  if (fen === 0) return '¥0.00';
  return `${fen > 0 ? '+' : '−'}${fenToYuan(Math.abs(fen))}`;
}

/** isDefault 在接口里是 0/1 数字；容错布尔与字符串 */
export function isDefaultChoice(choice) {
  const v = choice?.isDefault;
  return v === 1 || v === true || v === '1';
}

/**
 * 取某轮默认项。0 个或多个默认项时不猜：
 * 取 diffPrice 为 0 的首项，并返回 ambiguous 标记供输出使用。
 */
export function pickDefaultChoice(round) {
  const choices = round?.choices ?? [];
  const defaults = choices.filter(isDefaultChoice);
  if (defaults.length === 1) return { choice: defaults[0], ambiguous: false, reason: 'isDefault' };
  const zero = choices.filter((c) => parseDiffPrice(c.diffPrice).fen === 0);
  if (zero.length) {
    return {
      choice: zero[0],
      ambiguous: defaults.length > 1,
      reason: defaults.length > 1 ? 'multiple-defaults' : 'no-default',
    };
  }
  return { choice: choices[0] ?? null, ambiguous: true, reason: 'no-zero-choice' };
}

/**
 * 构造显式 roundList（基线必须显式传，避免隐式默认组合造成口径偏差）
 * @param {Array} rounds  query-meal-detail 的 rounds
 * @param {Record<string,string>} [selection]  roundId -> choiceCode 的覆盖
 */
export function buildRoundList(rounds, selection = {}) {
  const notes = [];
  const roundList = [];
  for (const round of rounds ?? []) {
    const { choice, ambiguous, reason } = pickDefaultChoice(round);
    const wantedCode = selection[String(round.id)];
    let picked = choice;
    if (wantedCode) {
      const found = (round.choices ?? []).find((c) => String(c.code) === String(wantedCode));
      if (found) picked = found;
      else notes.push(`第 ${round.id} 轮（${round.name}）不存在选项 ${wantedCode}，已退回默认项`);
    }
    if (ambiguous) notes.push(`第 ${round.id} 轮（${round.name}）默认项存在歧义（${reason}）`);
    if (!picked) continue;
    roundList.push({
      round: String(round.id),
      comboItemList: [{ code: String(picked.code), quantity: round.quantity || 1 }],
    });
  }
  return { roundList, notes };
}

/** 从 calculate-price 响应中抽取口径字段 */
export function summarizePrice(payload) {
  const d = payload?.data ?? payload;
  if (!d || typeof d.price !== 'number') return null;
  const P = d.price;
  const PR = typeof d.productPrice === 'number' ? d.productPrice : P;
  const OR =
    typeof d.productOriginalPrice === 'number'
      ? d.productOriginalPrice
      : typeof d.originalPrice === 'number'
        ? d.originalPrice
        : PR;
  return {
    priceFen: P,
    productPriceFen: PR,
    originalPriceFen: OR,
    absorbedFen: OR - PR,
    otherFen: P - PR,
    discountFen: typeof d.discount === 'number' ? d.discount : null,
    products: Array.isArray(d.productList) ? d.productList : [],
    enjoyable: d.enjoyable ?? null,
    emptyResult: !Array.isArray(d.productList) || d.productList.length === 0,
  };
}

/** 券专属商品识别：price 异常为 0 或 productList 为空 */
export function isBlockedPrice(summary, { mealCurrentPriceFen } = {}) {
  if (!summary) return true;
  if (summary.priceFen === 0) return true;
  if (summary.emptyResult) return true;
  if (mealCurrentPriceFen && summary.priceFen < mealCurrentPriceFen * 0.3) return true;
  return false;
}

/**
 * 两级归因
 * @param {{base:object, cand:object, menuDeltaFen:number, couponCoveredCodes?:string[], changedCodes?:string[]}} input
 */
export function attribute({ base, cand, menuDeltaFen, couponCoveredCodes = [], changedCodes = [] }) {
  const deltaFen = cand.priceFen - base.priceFen;
  const menuObsDeltaFen = cand.originalPriceFen - base.originalPriceFen;
  const couponDeltaFen = z(-(cand.absorbedFen - base.absorbedFen)); // <0 = 券多抵；>0 = 券少抵/失效
  const otherDeltaFen = z(cand.otherFen - base.otherFen);
  const residualFen = z(deltaFen - (menuDeltaFen + couponDeltaFen + otherDeltaFen));
  const menuMismatchFen = z(menuObsDeltaFen - menuDeltaFen);

  const couponBroken =
    base.absorbedFen > 0 &&
    bundleIntersects(couponCoveredCodes, changedCodes) &&
    cand.absorbedFen < base.absorbedFen;

  return {
    deltaFen: z(deltaFen),
    menuDeltaFen: z(menuDeltaFen),
    couponDeltaFen,
    otherDeltaFen,
    residualFen,
    menuObsDeltaFen,
    menuMismatchFen,
    couponBroken,
    level: Math.abs(residualFen) <= 2 ? 'ok' : Math.abs(residualFen) <= 500 ? 'note' : 'degraded',
  };
}

/** 消除 -0，避免 JSON 与断言出现 -0 */
function z(n) {
  return Object.is(n, -0) ? 0 : n;
}

function bundleIntersects(a = [], b = []) {
  const set = new Set(a.map(String));
  return b.some((code) => set.has(String(code)));
}

/**
 * 核价前的粗筛（省钱用）：只决定"哪些候选值得花一次 calculate-price"。
 * 必须带券缓冲，否则会漏掉"菜单补差超预算、但被券拉回预算内"的最优解。
 */
export function shortlistForPricing(entries, budgetFen, { couponBufferFen = 0, limit = 6, overflow = 3 } = {}) {
  const within = entries
    .filter((e) => e.menuDeltaFen <= budgetFen + couponBufferFen)
    .sort((a, b) => a.menuDeltaFen - b.menuDeltaFen);
  const over = entries
    .filter((e) => e.menuDeltaFen > budgetFen + couponBufferFen)
    .sort((a, b) => a.menuDeltaFen - b.menuDeltaFen);
  const reserve = Math.min(overflow, over.length, Math.max(0, limit - within.length));
  const picked = within.slice(0, limit - reserve);
  return [...picked, ...over.slice(0, limit - picked.length)];
}

/**
 * 定稿过滤：唯一判定标准是 ΔP（实付增量），不看菜单补差。
 * 菜单补差超预算但券把它拉回预算内的项，必须留在这里。
 */
export function filterByBudget(candidates, budgetFen) {
  const priced = candidates.filter((c) => c.attribution && typeof c.attribution.deltaFen === 'number');
  const eligible = priced.filter((c) => c.attribution.deltaFen <= budgetFen);
  const overBudget = priced
    .filter((c) => c.attribution.deltaFen > budgetFen)
    .sort((a, b) => a.attribution.deltaFen - b.attribution.deltaFen)
    .slice(0, 3);
  return { eligible, overBudget, unpriced: candidates.length - priced.length };
}

/** 券失效优先警示、预算内优先、加价小优先 */
export function sortCandidates(list) {
  return [...list].sort((a, b) => {
    if (a.attribution.couponBroken !== b.attribution.couponBroken) return a.attribution.couponBroken ? -1 : 1;
    const d = a.attribution.deltaFen - b.attribution.deltaFen;
    if (d !== 0) return d;
    return (b.score ?? 0) - (a.score ?? 0);
  });
}

/** 一句话结论：符号只出现在方向词上 */
export function describeDelta(attr) {
  if (attr.deltaFen === 0) return '不额外花钱';
  if (attr.deltaFen < 0) return `还便宜了 ${fenToYuan(Math.abs(attr.deltaFen))}`;
  return `多花 ${fenToYuan(attr.deltaFen)}`;
}

/** 归因行文案（禁止把残差摊进券或其它费用） */
export function attributionLines(attr) {
  const lines = [];
  lines.push({ label: '菜单补差', value: fenToSigned(attr.menuDeltaFen), kind: 'menu' });
  if (attr.couponDeltaFen !== 0) {
    lines.push({
      label: attr.couponDeltaFen < 0 ? '券多抵' : '券少抵（原券失效）',
      value: fenToYuan(Math.abs(attr.couponDeltaFen)),
      kind: attr.couponDeltaFen < 0 ? 'coupon-good' : 'coupon-bad',
    });
  }
  if (attr.otherDeltaFen !== 0) {
    lines.push({ label: '其它费用', value: fenToSigned(attr.otherDeltaFen), kind: 'other' });
  }
  if (attr.level === 'note') {
    lines.push({
      label: '未归因差额',
      value: fenToSigned(attr.residualFen),
      kind: 'residual',
      note: '菜单补差与服务端计价口径不一致，已计入总价，以门店结算为准',
    });
  }
  return lines;
}
