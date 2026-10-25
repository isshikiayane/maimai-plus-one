import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDiffPrice,
  attribute,
  fenToYuan,
  fenToSigned,
  describeDelta,
  pickDefaultChoice,
  buildRoundList,
  filterByBudget,
  shortlistForPricing,
  summarizePrice,
  isBlockedPrice,
} from '../scripts/engine.mjs';

const P = (price, orig, product) => ({
  priceFen: price,
  productPriceFen: product ?? price,
  originalPriceFen: orig ?? price,
  absorbedFen: (orig ?? price) - (product ?? price),
  otherFen: price - (product ?? price),
});

test('diffPrice 解析：正负零与失败', () => {
  assert.equal(parseDiffPrice('+ ¥8').fen, 800);
  assert.equal(parseDiffPrice('+ ¥2.5').fen, 250);
  assert.equal(parseDiffPrice('- ¥0.5').fen, -50);
  assert.equal(parseDiffPrice('+ ¥0').fen, 0);
  assert.equal(parseDiffPrice('+ ¥13').fen, 1300);
  assert.equal(parseDiffPrice('¥8').ok, false, '缺符号必须判失败');
  assert.equal(parseDiffPrice('').ok, false);
  assert.equal(parseDiffPrice(undefined).ok, false);
});

test('金额格式化：符号只出现在方向词上', () => {
  assert.equal(fenToYuan(800), '¥8.00');
  assert.equal(fenToYuan(-50), '-¥0.50');
  assert.equal(fenToSigned(800), '+¥8.00');
  assert.equal(fenToSigned(-50), '−¥0.50');
  assert.equal(describeDelta({ deltaFen: 800 }), '多花 ¥8.00');
  assert.equal(describeDelta({ deltaFen: -110 }), '还便宜了 ¥1.10');
  assert.equal(describeDelta({ deltaFen: 0 }), '不额外花钱');
});

test('算例1｜单轮换香草奶昔 +800，残差为 0', () => {
  const base = P(3650);
  const cand = P(4450);
  const attr = attribute({ base, cand, menuDeltaFen: 800 });
  assert.equal(attr.deltaFen, 800);
  assert.equal(attr.menuDeltaFen, 800);
  assert.equal(attr.couponDeltaFen, 0);
  assert.equal(attr.otherDeltaFen, 0);
  assert.equal(attr.residualFen, 0);
  assert.equal(attr.level, 'ok');
  assert.equal(attr.couponBroken, false);
});

test('算例2｜大薯条 +250 与奶昔 +800 同时替换 → +1050', () => {
  const base = P(3650);
  const cand = P(4700);
  const attr = attribute({ base, cand, menuDeltaFen: 250 + 800 });
  assert.equal(attr.deltaFen, 1050);
  assert.equal(attr.residualFen, 0);
});

test('算例3｜换掉券绑定商品：看着便宜 5 毛，实际多花 8.6 元', () => {
  // 券单：原价 1900，券后 990（吸收 910）
  const base = P(990, 1900, 990);
  assert.equal(base.absorbedFen, 910);
  // 换成玉米杯（d=-50），券绑定的是薯条，换掉后券失效
  const cand = P(1850, 1850, 1850);
  const attr = attribute({
    base,
    cand,
    menuDeltaFen: -50,
    couponCoveredCodes: ['4810'],
    changedCodes: ['4437'],
  });
  assert.equal(attr.deltaFen, 860);
  assert.equal(attr.menuDeltaFen, -50);
  assert.equal(attr.couponDeltaFen, 910, '券少抵 9.10 元');
  assert.equal(attr.residualFen, 0);
  // 只算 diffPrice 会得出"还便宜 0.5 元"，归因把它纠正为多花
  assert.ok(attr.deltaFen > 0, '归因后必须为正');
});

test('券失效标记：替换券绑定商品时必须置顶警示', () => {
  const base = P(990, 1900, 990);
  const broken = attribute({
    base,
    cand: P(1850, 1850, 1850),
    menuDeltaFen: -50,
    couponCoveredCodes: ['4810'],
    changedCodes: ['4810'],
  });
  assert.equal(broken.couponBroken, true);
  const safe = attribute({
    base,
    cand: P(1040, 1950, 1040),
    menuDeltaFen: 50,
    couponCoveredCodes: ['4810'],
    changedCodes: ['4437'],
  });
  assert.equal(safe.couponBroken, false);
});

test('算例4｜加价跨过券门槛：菜单 +8 元，实际只多花 3 元', () => {
  const base = P(3650);
  const cand = P(3950, 4450, 3950); // 原价 +800，券多抵 500
  const attr = attribute({ base, cand, menuDeltaFen: 800 });
  assert.equal(attr.deltaFen, 300);
  assert.equal(attr.couponDeltaFen, -500);
  assert.equal(attr.residualFen, 0);
});

test('残差分档：3–500 分标注，>500 分降级', () => {
  const note = attribute({ base: P(3650), cand: P(4500), menuDeltaFen: 800 });
  assert.equal(note.residualFen, 50);
  assert.equal(note.level, 'note');
  const bad = attribute({ base: P(3650), cand: P(5000), menuDeltaFen: 800 });
  assert.equal(bad.level, 'degraded');
});

test('默认项选择：唯一默认、多默认、无默认', () => {
  const one = pickDefaultChoice({
    id: '2',
    choices: [
      { code: 'a', name: 'A', isDefault: 1, diffPrice: '+ ¥0' },
      { code: 'b', name: 'B', isDefault: 0, diffPrice: '+ ¥2.5' },
    ],
  });
  assert.equal(one.choice.code, 'a');
  assert.equal(one.ambiguous, false);

  const multi = pickDefaultChoice({
    id: '2',
    choices: [
      { code: 'a', name: 'A', isDefault: 1, diffPrice: '+ ¥1' },
      { code: 'b', name: 'B', isDefault: 1, diffPrice: '+ ¥0' },
    ],
  });
  assert.equal(multi.choice.code, 'b', '多默认时取零补差项');
  assert.equal(multi.ambiguous, true);

  const none = pickDefaultChoice({
    id: '2',
    choices: [{ code: 'a', name: 'A', isDefault: 0, diffPrice: '+ ¥3' }],
  });
  assert.equal(none.reason, 'no-zero-choice');
});

test('显式 roundList 构造：覆盖选择与歧义留痕', () => {
  const rounds = [
    { id: 1, name: '主件', quantity: 1, choices: [{ code: '1100', name: '巨无霸', isDefault: 1, diffPrice: '+ ¥0' }] },
    {
      id: 2,
      name: '小食',
      quantity: 1,
      choices: [
        { code: '4810', name: '中薯条', isDefault: 1, diffPrice: '+ ¥0' },
        { code: '4820', name: '大薯条', isDefault: 0, diffPrice: '+ ¥2.5' },
      ],
    },
  ];
  const r = buildRoundList(rounds, { '2': '4820' });
  assert.equal(r.roundList.length, 2);
  assert.deepEqual(r.roundList[1], { round: '2', comboItemList: [{ code: '4820', quantity: 1 }] });
  const bad = buildRoundList(rounds, { '2': 'nope' });
  assert.equal(bad.roundList[1].comboItemList[0].code, '4810');
  assert.equal(bad.notes.length, 1);
});

test('预算过滤：ΔP 定稿，菜单补差超预算但实付被券拉回的项必须保留', () => {
  const mk = (menu, delta) => ({ attribution: { menuDeltaFen: menu, deltaFen: delta }, name: String(menu) });
  const cands = [mk(250, 250), mk(800, 300), mk(900, 900), mk(-50, 860)];
  const r = filterByBudget(cands, 500);
  assert.deepEqual(r.eligible.map((c) => c.name), ['250', '800']);
  assert.deepEqual(r.overBudget.map((c) => c.name), ['-50', '900'], '券失效导致实付 8.6 元的项必须落入超预算');
  assert.equal(r.unpriced, 0);
});

test('核价前粗筛：预算内优先，必要时用最接近的超预算项补位（上限 3 项）', () => {
  const entries = [
    { menuDeltaFen: 1200 },
    { menuDeltaFen: -50 },
    { menuDeltaFen: 800 },
    { menuDeltaFen: 250 },
    { menuDeltaFen: 1500 },
  ];
  const wide = shortlistForPricing(entries, 500, { limit: 4, overflow: 3 });
  assert.deepEqual(wide.map((e) => e.menuDeltaFen), [-50, 250, 800, 1200], '预算内优先，超预算按接近程度补位');
  const narrow = shortlistForPricing(entries, 500, { limit: 2, overflow: 3 });
  assert.deepEqual(narrow.map((e) => e.menuDeltaFen), [-50, 250], '名额不足时不得挤掉预算内项');
});

test('价格摘要与券专属商品识别', () => {
  const s = summarizePrice({
    data: {
      price: 3650,
      productPrice: 3650,
      productOriginalPrice: 3650,
      discount: 0,
      productList: [{ productCode: '9900005466' }],
      enjoyable: { amountType: '3', realDiscount: 5, balance: 250 },
    },
  });
  assert.equal(s.priceFen, 3650);
  assert.equal(s.absorbedFen, 0);
  assert.equal(isBlockedPrice(s, { mealCurrentPriceFen: 3650 }), false);

  const blocked = summarizePrice({ data: { price: 0, productPrice: 0, productList: [] } });
  assert.equal(isBlockedPrice(blocked), true);
});
