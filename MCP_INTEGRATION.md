# MCP 集成说明

本文档说明本项目**实际使用**的麦当劳 MCP Server、Tool、调用流程与业务价值，并附 2026-10-25 的真实脱敏调用记录。

---

## 一、使用的 MCP Server

| 项 | 值 |
|---|---|
| Server | 麦当劳中国官方 MCP：`https://mcp.mcd.cn` |
| 传输方式 | Streamable HTTP（JSON-RPC 2.0） |
| 鉴权 | 请求头 `Authorization: Bearer <MCP Token>`，令牌在 [open.mcd.cn/mcp](https://open.mcd.cn/mcp) 申请 |
| 协议握手 | `initialize`（`protocolVersion: 2024-11-05`）→ `notifications/initialized` → `tools/call`，服务端返回 `mcp-session-id` 后续请求复用 |
| 返回形态 | `content[0].text` 为 JSON 字符串，业务体在 `data` 字段内；失败时为 `{"success":false,"code":...,"message":...}` |
| 限流 | 600 次/分钟；本项目客户端节流 ≥200ms/次（≤5 rps），429/5xx 指数退避 1s/2s/4s，单会话硬上限 40 次 |
| 本地实现 | **无**。官方仓库仅含 README，无源码、无 mock，全部为远程托管 |

## 二、使用的 Tool 清单

| Tool | 在本项目中的用途 | 只读 | 关键入参 |
|---|---|---|---|
| `query-nearby-stores` | 按城市+关键词定位可到店自取门店 | 是 | `beType=1`, `searchType=2`, `city`, `keyword` |
| `query-meals` | 拉取门店在售套餐，取得套餐 `code` 与 `currentPrice` | 是 | `storeCode`, `orderType=1`, `beType=1` |
| `query-meal-detail` | **核心**：读取套餐 `rounds[].choices[]`，含 `diffPrice`（官方公示补差）、`isDefault`、`maxQuantity` | 是 | `storeCode`, `orderType=1`, `beType=1`, `code` |
| `query-store-coupons` | 取得**当前门店+到店渠道**可用券的 `couponId/couponCode/products[]`，用于实测券是否影响实付 | 是 | `storeCode`, `orderType=1`, `beType=1` |
| `calculate-price` | **核心**：对原餐与每个候选分别核价；传 `items[].roundList` 实现套餐子项替换 | 是（无副作用） | `storeCode`, `orderType`, `beType`, `items[].productCode/quantity/roundList/couponId/couponCode`, `needTableware` |
| `now-time-info` | 判定当前时段（早餐/正餐）以解释菜单差异 | 是 | — |

**未使用**（主动排除的写操作与无关能力）：`create-order`、`cancel-order`、`delivery-create-address`、`auto-bind-coupons`、`draw-lottery`、`party-order-create`、`mall-create-order`、`query-my-coupons`。

> `query-my-coupons` 被明确排除：官方说明该接口"不进行门店、渠道、配送方式等下单规则校验，不承诺可用于当前订单"，用它计价会产出假价格。取券只走 `query-store-coupons`。

## 三、调用流程

### 3.1 主流程：一次"加一点"决策（典型 8–12 次调用）

```
S0  query-nearby-stores(city, keyword)            → storeCode
S1  query-meals(storeCode)                         → 套餐 code / 名称 / 现价
S2  query-meal-detail(storeCode, mealCode)         → rounds[].choices[] + diffPrice
S3  本地：意图→候选池（deny 优先），取 ≤4 个候选
S4  query-store-coupons(storeCode)                 → 券与券绑定商品
S5  calculate-price(显式 roundList = 全默认组合)    → 基线实付 P_base
    calculate-price(省略 roundList)                → 探针，验证 round 通道是否生效
    对每个候选：calculate-price(roundList 替换该项) → P_cand
S6  本地：ΔP = P_cand − P_base，拆成 菜单补差 / 券影响 / 其它 / 残差
S7  输出：改了什么 / 真实多花多少 / 得到什么 / 数据来源与时间
```

**关键实现细节（均为实测确认）**

1. **基线必须显式传 `roundList`**，各轮取 `isDefault=1` 的选项。不传会使用服务端隐式默认组合，导致基线自带一笔看不见的补差，后续归因基准全部偏移。本项目同时跑一次"不传 roundList"的探针，把两个价格的差异单独记录（`baseline.probe`），不计入残差。
2. **`roundList[].round` 传 `rounds[].id` 的字符串**。官方 schema 只写"套餐round"，无文档说明取值；本项目以实测确认传 `rounds[].id` 生效，并保留失效检测：若某候选带 `roundList` 与不带的价格相同，判定通道失效并降级为"仅菜单补差"。
3. **券是商品级参数**（`items[].couponId/couponCode`），不存在订单级券字段。带券与不带券各算一次，差额即券的真实影响。

### 3.2 旁路：加价榜（约 1 + 1 + K 次调用）

```
query-meals → 取 K 个套餐
对每个套餐 query-meal-detail → 收集所有 choices[].diffPrice
按 不加反降 / ¥1 内 / ¥1–3 / ¥3–5 四档聚合
```

该榜**只做菜单层统计，不逐项核价**，因此页面与输出中一律标 `†`，并在免责中写明"不等于实付"。跨套餐不排名：`diffPrice` 是相对各自套餐基础配置的补差，绝对值不可比。

### 3.3 演示：快照回放（0 次调用）

真实抓取后把结果脱敏写入 `web/data.json`，再由构建脚本内联进 `web/index.html`。页面零网络请求，双击即可打开——既解决"无 token 无法演示"，也规避了 `file://` 下 `fetch` 被 CORS 拦截的问题。

## 四、业务价值

| 用户问题 | 依赖的 MCP 能力 | 本项目产出 |
|---|---|---|
| "这个套餐能不能换饮料？有哪些选项？" | `query-meal-detail` 的 `rounds[].choices[]` | 该店该套餐的可替换项全量清单与官方公示补差 |
| "换这个到底多花多少钱？" | `calculate-price` × 2（原餐 / 候选） | 实付差额，且与菜单补差分列，不混用 |
| "我有券，换了之后还能用吗？" | `query-store-coupons` + `calculate-price` 带券对照 | 券是否影响实付；套餐替换被拒时原样输出 `600012` |
| "最多加 5 块，哪个最值？" | 上述链路 + 本地排序 | 预算内候选矩阵；无解时明确说"没有"并给最近超预算项 |
| "这家店每个价位能换什么？" | `query-meal-detail` 批量 | 四档加价榜（`†` 菜单层口径） |

## 五、真实调用记录（2026-10-25，门店 1450713）

### 5.1 汇总

| Tool | 次数 | 平均耗时 |
|---|---:|---:|
| `calculate-price` | 24 | 341 ms |
| `query-meal-detail` | 6 | 190 ms |
| `query-meals` | 2 | 320 ms |
| `query-store-coupons` | 4 | 119 ms |
| **合计** | **36** | — |

全量 36 条记录（含每次入参摘要与返回金额）保存在 `web/data.json` 的 `audit` 字段，可直接在演示页"调用审计"区展开查看。

### 5.2 关键实测片段（金额单位：分）

| 请求 | 返回 |
|---|---|
| 巨无霸三件套，显式默认 `roundList` | `price 3650` / `productPrice 3650` / `discount 0` |
| 同上，第 3 轮换 `507411`（麦咖啡™冰美式中杯，`diffPrice + ¥9`） | `price 4550`（= 3650 + 900） |
| 同上，第 2 轮换 `4810→4820`（大薯条 `+¥2.5`）+ 第 3 轮换 `521588`（香草奶昔 `+¥8`） | `price 4700`（= 3650 + 250 + 800） |
| 麦辣鸡腿堡三件套，第 3 轮换 `520688`（大杯鲜萃咖啡 `+¥1.5`） | `price 3500`（= 3350 + 150） |
| 套餐 + 9.9 元冰美式券 | `{"success":false,"code":600012,"message":"促销规则不支持该商品"}` |
| 同一张券用于**单点**冰美式（`507411`） | `productOriginalPrice 1900` → `price 990`，`discount 910` |

### 5.3 由此确认的两条能力边界

1. **券不能与套餐内替换叠加**（`600012`），只能作用于单点商品。因此"有券就更便宜"在本场景不成立，工具不对此做任何假设。
2. **`diffPrice` 是解释量而非报价量**。它只说明"菜单上贵了多少"，与实付差额之间还隔着券与套餐自身优惠。

## 六、校准方式与兼容性

- **金额口径**：内部一律整数分，禁用浮点；展示两位小数。`diffPrice` 用 `^([+-])\s*¥\s*([\d.]+)$` 解析，解析失败标记 `unparsed` 并跳过该候选，**绝不当 0 处理**。
- **默认项歧义**：某轮 `isDefault` 为 0 个或多个时，取 `diffPrice=+¥0` 的首项，并在输出备注中说明歧义，不静默猜测。
- **协议漂移检测**：`probe.mjs` 落盘真实响应到 `.cache/` 仅打印结构摘要，用于发现字段改名；`round` 通道失效时全局降级为「仅菜单补差」并在页面横幅提示。
- **工具名兼容**：README 中 `query-partystore-*` 与实际 `query-party-store-*` 不一致，本项目以 `tools/list` 的实际返回为准。

## 七、数据隐私

- Token 只从环境变量 `MCD_MCP_TOKEN` 读取，**不写入任何文件、日志、快照或提交记录**；`mcp-config.example.json` 仅含占位符。
- 快照经过白名单抽取：只保留门店公开信息、商品名、`code`、金额、耗时；不包含手机号、会员号、openid、收货地址、券完整 ID。
- 券仅记录是否存在及其绑定商品，`couponId` 不落盘。
- 对外分享的演示页**不含任何账号态数据**，因此无需登录、也无法反推个人订单。
- 全链路只读：本项目不存在任何下单、领券、抽奖调用。
