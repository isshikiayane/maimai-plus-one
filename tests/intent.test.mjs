import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRound, resolveIntent, detectUnsupported, enumerateCandidates } from '../scripts/intent.mjs';

const ch = (code, name, diff, extra = {}) => ({
  code,
  name,
  diffPrice: diff,
  isDefault: 0,
  maxQuantity: -1,
  ...extra,
});

const rounds = [
  {
    id: 1,
    name: '新升级巨无霸',
    quantity: 1,
    choices: [ch('1100', '巨无霸', '+ ¥0', { isDefault: 1 })],
  },
  {
    id: 2,
    name: '选择套餐内小食',
    quantity: 1,
    choices: [
      ch('4810', '中薯条', '+ ¥0', { isDefault: 1 }),
      ch('4820', '大薯条', '+ ¥2.5'),
      ch('4437', '小杯玉米杯', '- ¥0.5'),
      ch('4438', '大杯玉米杯', '+ ¥2.5'),
      ch('9999', '已售罄小食', '+ ¥1', { maxQuantity: 0 }),
    ],
  },
  {
    id: 3,
    name: '选择套餐内饮料',
    quantity: 1,
    choices: [
      ch('3050', '可乐中杯', '+ ¥0', { isDefault: 1 }),
      ch('520688', '大杯鲜萃咖啡', '+ ¥1.5'),
      ch('507411', '麦咖啡™冰美式中杯', '+ ¥9'),
      ch('6001', '咖啡味圣代', '+ ¥3'),
      ch('3071', '无糖可口可乐中杯', '+ ¥0'),
      ch('521588', '香草风味奶昔', '+ ¥8'),
      ch('7778', '冷萃咖啡大杯', '面议'),
    ],
  },
];

test('轮域判定：饮料 / 小食 / 主件', () => {
  assert.equal(classifyRound(rounds[0]), 'main');
  assert.equal(classifyRound(rounds[1]), 'side');
  assert.equal(classifyRound(rounds[2]), 'drink');
});

test('意图识别与不可靠意图的降级/拒绝', () => {
  assert.equal(resolveIntent('想喝咖啡').id, 'coffee');
  assert.equal(resolveIntent('想少糖').id, 'lessSugar');
  assert.equal(resolveIntent('想更饱').id, 'fuller');
  assert.equal(resolveIntent('换个小食').id, 'side');
  assert.equal(resolveIntent('随便'), null);

  assert.equal(detectUnsupported('对花生过敏，能换吗').mode, 'refuse');
  assert.equal(detectUnsupported('我在减脂').mode, 'degrade');
  assert.equal(detectUnsupported('有没有新品').mode, 'degrade');
  assert.equal(detectUnsupported('想喝咖啡'), null);
});

test('咖啡意图：命中咖啡项，剔除「咖啡味」冰淇淋', () => {
  const { candidates } = enumerateCandidates(rounds, resolveIntent('咖啡'), { limit: 10 });
  const names = candidates.map((c) => c.to.name);
  assert.ok(names.includes('大杯鲜萃咖啡'));
  assert.ok(names.includes('麦咖啡™冰美式中杯'));
  assert.ok(!names.includes('咖啡味圣代'), 'deny 必须优先于 allow');
  assert.ok(!names.includes('香草风味奶昔'), '非咖啡饮料不得进入咖啡候选');
  assert.ok(candidates.every((c) => c.roundId === '3'), '只应出现在饮料轮');
});

test('更饱意图：取加量项，剔除小份', () => {
  const { candidates } = enumerateCandidates(rounds, resolveIntent('想更饱'), { limit: 10 });
  const names = candidates.map((c) => c.to.name);
  assert.ok(names.includes('大薯条'));
  assert.ok(names.includes('大杯玉米杯'));
  assert.ok(!names.includes('小杯玉米杯'), '小份必须被 deny 剔除');
});

test('无法解析的补差价必须跳过并留痕，不能当 0', () => {
  const { candidates, notes } = enumerateCandidates(rounds, resolveIntent('咖啡'), { limit: 10 });
  assert.ok(!candidates.some((c) => c.to.code === '7778'));
  assert.ok(notes.some((n) => n.includes('冷萃咖啡大杯')), '无法解析的补差必须留痕');
});

test('售罄项（maxQuantity=0）与默认项自身不进候选', () => {
  const { candidates } = enumerateCandidates(rounds, resolveIntent('换个小食'), { limit: 10 });
  const codes = candidates.map((c) => c.to.code);
  assert.ok(!codes.includes('9999'));
  assert.ok(!codes.includes('4810'), '默认项不应作为候选');
  assert.ok(codes.includes('4820'));
});

test('候选数量受 limit 约束，且默认项被记录为 from', () => {
  const { candidates } = enumerateCandidates(rounds, resolveIntent('换个小食'), { limit: 2 });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].from.name, '中薯条');
});

test('avoidCodes 生效', () => {
  const { candidates } = enumerateCandidates(rounds, resolveIntent('换个小食'), {
    avoidCodes: ['4820'],
    limit: 10,
  });
  assert.ok(!candidates.some((c) => c.to.code === '4820'));
});
