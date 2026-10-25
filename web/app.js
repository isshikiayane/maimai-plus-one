/* 麦麦加一点 · 快照回放渲染（零依赖，数据由 index.html 内联注入） */
(function () {
  var S = window.__SNAPSHOT__;
  var root = document.getElementById('app');
  if (!S) {
    root.innerHTML = '<p style="padding:40px;font-family:monospace">未找到内联快照数据。</p>';
    return;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function yuan(fen) {
    if (fen == null || isNaN(fen)) return '—';
    return '¥' + (Math.abs(fen) / 100).toFixed(2);
  }
  function signed(fen) {
    if (fen == null || isNaN(fen)) return '—';
    if (fen === 0) return '¥0.00';
    return (fen > 0 ? '+' : '−') + yuan(fen);
  }
  function numClass(fen) {
    if (fen > 0) return 'plus';
    if (fen < 0) return 'minus';
    return 'zero';
  }
  function deltaText(fen) {
    if (fen === 0) return '不额外花钱';
    if (fen < 0) return '还便宜了 ' + yuan(fen);
    return '多花 ' + yuan(fen);
  }

  var plans = S.plans || [];
  var hero =
    plans.filter(function (p) {
      return p.eligible && p.eligible.length && /巨无霸/.test(p.mealName || '');
    })[0] ||
    plans.filter(function (p) {
      return p.eligible && p.eligible.length;
    })[0];

  var auditCount = (S.audit || []).length;
  var store = S.store || {};

  /* ---------- header ---------- */
  var html = '';
  html += '<header class="top">';
  html += '<div class="brandline"><h1>麦麦加一点</h1><span class="en">maimai-plus-one</span></div>';
  html +=
    '<p class="tagline">给已经选好的那份套餐加一点预算，换一个更对的选项——并且说清这一点钱花在了哪里。所有价格均来自官方 <code>calculate-price</code> 实算，不是估算。</p>';
  html += '<div class="meta">';
  html += '<span class="chip">门店 ' + esc(store.storeCode) + '</span>';
  html += '<span class="chip">到店自取</span>';
  html += '<span class="chip">抓取 ' + esc((S.generatedAt || '').replace('T', ' ').slice(0, 19)) + '</span>';
  html += '<span class="chip hot">' + auditCount + ' 次真实 MCP 调用</span>';
  html += '<span class="chip">零依赖 · 离线可开</span>';
  html += '</div></header>';

  /* ---------- hero ---------- */
  if (hero && hero.eligible.length) {
    var best = hero.eligible[0];
    var a = best.attribution;
    var maxAbs = Math.max(Math.abs(a.menuDeltaFen), Math.abs(a.couponDeltaFen), Math.abs(a.otherDeltaFen), 1);
    html += '<section><div class="hero"><div class="hero-left">';
    html += '<div class="kicker">典型一单 · ' + esc(hero.mealName) + '</div>';
    html +=
      '<p class="swap">' +
      esc(best.from ? best.from.name : '默认搭配') +
      '<span class="arrow">→</span>' +
      esc(best.to.name) +
      '</p>';
    html += '<p class="swap-sub">' + esc(best.roundName) + '　·　目标：' + esc(hero.intentLabel) + '</p>';
    html += '<div class="bignum">' + deltaText(a.deltaFen).replace(/^(多花 |还便宜了 )/, '') + '<small>' +
      (a.deltaFen >= 0 ? '多花' : '反而便宜') + '</small></div>';
    html +=
      '<div class="priceflow">原餐 <b>' +
      yuan(hero.baseline.priceFen) +
      '</b> → 换后 <b>' +
      yuan(best.priceFen) +
      '</b>　·　预算最多再加 ' +
      yuan(hero.budgetFen) +
      '</div>';
    html += '</div><div class="hero-right">';
    html += '<div class="kicker">这 ' + yuan(Math.abs(a.deltaFen)) + ' 从哪来</div>';
    html += attrRow('菜单补差', a.menuDeltaFen, maxAbs, 'menu', '查自套餐内选项公示差价');
    html += attrRow('券的影响', a.couponDeltaFen, maxAbs, 'coupon', a.couponDeltaFen === 0 ? '两侧同为无券' : '实测带券与不带券各算一次');
    html += attrRow('其它费用', a.otherDeltaFen, maxAbs, '', '到店自取通常为 0');
    html +=
      '<div class="attrrow total"><span class="lbl">合计实付差额</span><span class="bar"></span><span class="val">' +
      signed(a.deltaFen) +
      '</span></div>';
    html += '</div></div></section>';
  }

  /* ---------- matrix ---------- */
  html += '<section><div class="sec-head"><span class="idx">01</span><h2>候选矩阵：每一行都经真实核价</h2><span class="note">菜单补差 † 与实付多花 ✓ 分列，不混用</span></div>';
  plans.forEach(function (p) {
    if (!p.eligible || !p.eligible.length) return;
    html += '<div class="tablebox" style="margin-bottom:18px">';
    html += '<div class="planbar"><span class="nm">' + esc(p.mealName) + '</span>';
    html += '<span class="intent">目标：' + esc(p.intentLabel) + '</span>';
    html += '<span class="base">原餐实付 ' + yuan(p.baseline.priceFen) + '　预算 +' + yuan(p.budgetFen) + '</span></div>';
    html += '<table><thead><tr>';
    html += '<th>换什么</th><th>菜单补差 †</th><th>实付多花 ✓</th><th>差额构成</th><th>为什么是它</th>';
    html += '</tr></thead><tbody>';
    p.eligible.forEach(function (c) {
      var t = c.attribution;
      html += '<tr>';
      html +=
        '<td><b>' +
        esc(c.to.name) +
        '</b><div class="dim">' +
        esc(c.from ? c.from.name : '默认') +
        ' → ' +
        esc(c.to.name) +
        '　·　' +
        esc(c.roundName) +
        '</div></td>';
      html += '<td class="num ' + numClass(t.menuDeltaFen) + '">' + signed(t.menuDeltaFen) + '</td>';
      html += '<td class="num ' + numClass(t.deltaFen) + '">' + signed(t.deltaFen) + '</td>';
      html += '<td class="dim">' + constitution(t) + '</td>';
      html += '<td class="why">' + esc(c.why) + '</td>';
      html += '</tr>';
    });
    (p.overBudget || []).forEach(function (c) {
      var t = c.attribution;
      html += '<tr style="opacity:.72">';
      html +=
        '<td><b>' +
        esc(c.to.name) +
        '</b> <span class="badge over">超预算</span><div class="dim">' +
        esc(c.roundName) +
        '</div></td>';
      html += '<td class="num ' + numClass(t.menuDeltaFen) + '">' + signed(t.menuDeltaFen) + '</td>';
      html += '<td class="num ' + numClass(t.deltaFen) + '">' + signed(t.deltaFen) + '</td>';
      html += '<td class="dim">' + constitution(t) + '</td>';
      html += '<td class="why">超出预算 ' + yuan(t.deltaFen - p.budgetFen) + '，仅作参照，不推荐</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
  });
  html += '<p class="legend"><b>† 菜单补差</b>：套餐内选项的公示差价，不等于实付差额。<b>✓ 实付多花</b>：对原餐与候选各调用一次 <code>calculate-price</code> 得到的实际应付差额，这是唯一真值。</p>';
  html += '</section>';

  /* ---------- leaderboard ---------- */
  var lb = S.leaderboard || { buckets: {} };
  var order = [
    ['drop', '不加反降', '换它反而更便宜'],
    ['one', '¥1 以内', '含大量 0 元替换'],
    ['three', '¥1 – 3', '最常见的加价档'],
    ['five', '¥3 – 5', '升级到更大杯'],
  ];
  html += '<section><div class="sec-head"><span class="idx">02</span><h2>加价榜：这家店每个价位能换到什么</h2><span class="note">' +
    (lb.total || 0) + ' 个替换项 · ' + (lb.meals ? lb.meals.length : 0) + ' 个套餐</span></div>';
  html += '<div class="buckets">';
  order.forEach(function (pair) {
    var list = (lb.buckets && lb.buckets[pair[0]]) || [];
    html += '<div class="bucket"><h3>' + pair[1] + '<span>' + list.length + ' 项</span></h3><ul>';
    list.slice(0, 7).forEach(function (e) {
      html += '<li><span class="d ' + numClass(e.diffPriceFen) + '">' + signed(e.diffPriceFen) + '</span>';
      html += '<span class="nm">' + esc(e.choiceName) + '<div class="src">' + esc(e.mealName) + ' · ' + esc(e.roundName) + '</div></span></li>';
    });
    if (!list.length) html += '<li class="dim">本档无选项</li>';
    html += '</ul></div>';
  });
  html += '</div>';
  html += '<p class="legend">本榜数值全部取自套餐内选项的公示差价（<b>†</b>），未逐项核价；加价额只在同一套餐内部可比，<b>不做跨套餐排名</b>。</p>';
  html += '</section>';

  /* ---------- finding ---------- */
  var couponNote = null;
  plans.forEach(function (p) {
    if (!couponNote && p.couponContext && p.couponContext.notes && p.couponContext.notes.length) {
      couponNote = p.couponContext.notes[0];
    }
  });
  if (couponNote) {
    html += '<section><div class="callout"><h3>一个只有真问过服务端才会知道的结论</h3>';
    html += '<p style="margin:0">门店券<b>不能</b>与套餐内替换叠加。把套餐里的可乐换成「麦咖啡™冰美式中杯」时，带上那张 9.9 元券，服务端直接拒绝：</p>';
    html += '<div class="quote">{"success":false,"code":600012,"message":"促销规则不支持该商品"}</div>';
    html += '<p style="margin:8px 0 0">同一张券用在<b>单点</b>商品上则正常生效（原价 ¥19.00 → 实付 ¥9.90，抵 ¥9.10）。所以本工具不会假设"有券就更便宜"，只会报告服务端实际接受的结果。</p>';
    html += '</div></section>';
  }

  /* ---------- audit ---------- */
  html += '<section><div class="sec-head"><span class="idx">03</span><h2>调用审计：每个数字都能追到一次请求</h2><span class="note">共 ' + auditCount + ' 次</span></div>';
  html += '<details class="audit"><summary>展开逐条调用记录（工具 / 入参 / 耗时 / 金额）</summary>';
  html += '<div class="audit-table"><table><thead><tr><th>#</th><th>工具</th><th>关键入参</th><th>耗时</th><th>返回金额</th></tr></thead><tbody>';
  (S.audit || []).forEach(function (e) {
    var amount = e.result && e.result.price != null ? yuan(e.result.price) : '—';
    if (e.result && e.result.price != null && e.result.discount) amount += '（抵 ' + yuan(e.result.discount) + '）';
    html += '<tr><td class="num">' + e.seq + '</td>';
    html += '<td class="tool">' + esc(e.tool) + '</td>';
    html += '<td class="dim">' + esc(brief(e.argsSummary)) + '</td>';
    html += '<td class="num dim">' + e.ms + ' ms</td>';
    html += '<td class="num">' + esc(amount) + '</td></tr>';
  });
  html += '</tbody></table></div></details></section>';

  /* ---------- bounds ---------- */
  html += '<section><div class="sec-head"><span class="idx">04</span><h2>能力边界</h2><span class="note">做不到的也说清楚</span></div><div class="bounds">';
  html += '<div><h3>做得到</h3><ul>';
  html += '<li>在真实门店菜单里枚举套餐内可替换项，加价取自 <code>diffPrice</code>，不自行推算</li>';
  html += '<li>对原餐与每个候选各核一次价，差价来自服务端，含券与不含券分别实测</li>';
  html += '<li>把差价拆成菜单补差 / 券影响 / 其它费用，残差不为 0 时如实标注</li>';
  html += '<li>预算内没有合适项时，明确说"没有"，并给出最接近的超预算项</li>';
  html += '</ul></div>';
  html += '<div><h3>做不到 / 不做</h3><ul>';
  html += '<li>跨套餐比较：<code>diffPrice</code> 是相对各自套餐的补差，绝对值不可比</li>';
  html += '<li>外送与团餐：到店场景没有满减规则查询能力</li>';
  html += '<li>营养与过敏原结论：接口无过敏原数据，涉及健康问题一律不猜</li>';
  html += '<li>下单：全链路只读，永不调用 <code>create-order</code></li>';
  html += '</ul></div></div></section>';

  /* ---------- footer ---------- */
  html += '<footer><b>免责与数据来源</b><ol>';
  (S.disclaimers || []).forEach(function (d) {
    html += '<li>' + esc(d) + '</li>';
  });
  html += '</ol><p style="margin-top:10px">本页由快照生成，无需令牌即可打开；数据为真实抓取后脱敏保存，不含任何账号凭证、手机号或地址。截图与引用请保留抓取时间。</p></footer>';

  root.innerHTML = html;

  function attrRow(label, fen, maxAbs, cls, hint) {
    var w = Math.min(100, (Math.abs(fen) / maxAbs) * 100);
    return (
      '<div class="attrrow" title="' + esc(hint) + '"><span class="lbl">' +
      esc(label) +
      '</span><span class="bar"><i class="' + cls + '" style="width:' + w + '%"></i></span><span class="val ' +
      (cls === 'coupon' && fen < 0 ? 'good' : '') +
      '">' +
      signed(fen) +
      '</span></div>'
    );
  }

  function constitution(t) {
    var parts = ['菜单 ' + signed(t.menuDeltaFen)];
    if (t.couponDeltaFen !== 0) parts.push((t.couponDeltaFen < 0 ? '券多抵 ' : '券少抵 ') + yuan(t.couponDeltaFen));
    else parts.push('券无影响');
    if (t.otherDeltaFen !== 0) parts.push('其它 ' + signed(t.otherDeltaFen));
    if (t.residualFen !== 0) parts.push('未归因 ' + signed(t.residualFen));
    return parts.join('　·　');
  }

  function brief(args) {
    if (!args) return '—';
    var bits = [];
    if (args.code) bits.push('code=' + args.code);
    if (args.storeCode) bits.push('store=' + args.storeCode);
    if (args.items) {
      args.items.forEach(function (it) {
        var s = it.productCode;
        if (it.rounds && it.rounds.length) s += ' [' + it.rounds.join('; ') + ']';
        if (it.coupon) s += ' +券';
        bits.push(s);
      });
    }
    return bits.join(' ');
  }
})();
