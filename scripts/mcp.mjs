/**
 * 零依赖 MCP 客户端（Streamable HTTP / JSON-RPC 2.0）
 *
 * 安全约定：
 *  - 令牌只从环境变量 MCD_MCP_TOKEN 读取，绝不写入任何文件、日志或输出。
 *  - 审计记录只保存入参摘要与金额，不含 token / couponId 全量 / 手机号。
 */

const DEFAULT_ENDPOINT = 'https://mcp.mcd.cn';
const MIN_INTERVAL_MS = 200; // ≤5 rps，官方限流 600/min
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  constructor(minIntervalMs = MIN_INTERVAL_MS) {
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
  }
  async wait() {
    const gap = this.minIntervalMs - (Date.now() - this.last);
    if (gap > 0) await sleep(gap);
    this.last = Date.now();
  }
}

export class McpError extends Error {
  constructor(message, { status, tool, body } = {}) {
    super(message);
    this.name = 'McpError';
    this.status = status;
    this.tool = tool;
    this.body = body;
  }
}

export class McpClient {
  /**
   * @param {{token?: string, endpoint?: string, budget?: number, onAudit?: (e:any)=>void}} opts
   */
  constructor(opts = {}) {
    this.token = opts.token ?? process.env.MCD_MCP_TOKEN ?? '';
    this.endpoint = opts.endpoint ?? process.env.MCD_MCP_URL ?? DEFAULT_ENDPOINT;
    this.sessionId = null;
    this.rpcId = 0;
    this.limiter = new RateLimiter();
    this.audit = [];
    this.calls = 0;
    this.budget = opts.budget ?? Number(process.env.MAIMAI_CALL_BUDGET ?? 40);
    this.onAudit = opts.onAudit;
    this.initialized = false;
  }

  get hasToken() {
    return Boolean(this.token);
  }

  async #request(payload, { isNotification = false } = {}) {
    if (!this.token) {
      throw new McpError('缺少 MCD_MCP_TOKEN 环境变量，无法访问麦当劳 MCP。', {
        status: 401,
      });
    }
    await this.limiter.wait();

    const headers = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (payload.method === 'initialize') headers['mcp-protocol-version'] = '2024-11-05';

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (isNotification) return null;

    const text = await res.text();
    if (!res.ok) {
      throw new McpError(`HTTP ${res.status} ${res.statusText}`, {
        status: res.status,
        body: text.slice(0, 500),
      });
    }
    return parseRpcBody(text, res.headers.get('content-type') || '');
  }

  async init() {
    if (this.initialized) return;
    const id = ++this.rpcId;
    await this.#request({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'maimai-plus-one', version: '0.1.0' },
      },
    });
    await this.#request(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { isNotification: true }
    );
    this.initialized = true;
  }

  async listTools() {
    await this.init();
    const body = await this.#request({
      jsonrpc: '2.0',
      id: ++this.rpcId,
      method: 'tools/list',
      params: {},
    });
    return body?.result?.tools ?? [];
  }

  /**
   * 调用工具，返回解析后的业务对象。
   * MCP tools/call 返回 content[]，麦当劳服务返回单个 text 分区，内容为 JSON 字符串。
   */
  async call(tool, args = {}) {
    await this.init();
    if (this.calls >= this.budget) {
      throw new McpError(`已达到本次会话调用上限（${this.budget} 次），已停止继续请求。`, {
        status: 429,
        tool,
      });
    }

    const seq = ++this.calls;
    const startedAt = Date.now();
    let attempt = 0;
    let lastErr;

    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      try {
        const body = await this.#request({
          jsonrpc: '2.0',
          id: ++this.rpcId,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        });
        const ms = Date.now() - startedAt;
        const payload = extractToolPayload(body?.result);
        const entry = {
          seq,
          ts: new Date().toISOString(),
          tool,
          argsSummary: summarizeArgs(tool, args),
          ms,
          status: 'ok',
          result: summarizeResult(tool, payload),
        };
        this.#pushAudit(entry);
        return payload;
      } catch (err) {
        lastErr = err;
        const retryable =
          err?.status === 429 || (err?.status >= 500 && err?.status < 600) || err?.status === undefined;
        if (!retryable || attempt >= MAX_ATTEMPTS) break;
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }

    this.#pushAudit({
      seq,
      ts: new Date().toISOString(),
      tool,
      argsSummary: summarizeArgs(tool, args),
      ms: Date.now() - startedAt,
      status: lastErr?.status === 429 ? 'rate-limited' : 'error',
      result: { error: String(lastErr?.message || lastErr).slice(0, 200) },
    });
    throw lastErr;
  }

  #pushAudit(entry) {
    this.audit.push(entry);
    try {
      this.onAudit?.(entry);
    } catch {
      /* 审计回调不得影响主流程 */
    }
  }
}

function parseRpcBody(text, contentType) {
  if (!text) return null;
  if (contentType.includes('text/event-stream')) {
    const events = text.split(/\r?\n\r?\n/);
    let last = null;
    for (const block of events) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        last = JSON.parse(data);
      } catch {
        /* 允许心跳等非 JSON 事件 */
      }
    }
    return last;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

function extractToolPayload(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  const textPart = (result.content || []).find((c) => c.type === 'text');
  if (!textPart) return result;
  const raw = textPart.text;
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return { _text: raw };
  }
}

/** 入参摘要：只保留可公开的业务字段，不保留任何凭证 */
export function summarizeArgs(tool, args) {
  const items = Array.isArray(args?.items) ? args.items : [];
  const summary = {
    storeCode: args?.storeCode ?? null,
    beType: args?.beType ?? null,
    orderType: args?.orderType ?? null,
    city: args?.city ?? null,
    keyword: args?.keyword ?? null,
    code: args?.code ?? null,
  };
  if (items.length) {
    summary.items = items.map((it) => ({
      productCode: it.productCode,
      quantity: it.quantity,
      coupon: Boolean(it.couponId || it.couponCode),
      rounds: (it.roundList || []).map((r) => `${r.round}→${(r.comboItemList || []).map((c) => c.code).join('+')}`),
    }));
  }
  return Object.fromEntries(Object.entries(summary).filter(([, v]) => v !== null && v !== undefined));
}

/** 结果摘要：只保留金额相关的关键字段，用于审计表展示 */
export function summarizeResult(_tool, payload) {
  const d = payload?.data ?? payload;
  if (!d || typeof d !== 'object') return {};
  const pick = (k) => (d[k] === undefined ? undefined : d[k]);
  const out = {};
  for (const k of ['price', 'productPrice', 'originalPrice', 'discount', 'shippingFee', 'packingFee']) {
    const v = pick(k);
    if (v !== undefined) out[k] = v;
  }
  if (Array.isArray(d.productList)) out.productListCount = d.productList.length;
  if (d.enjoyable && typeof d.enjoyable === 'object') {
    out.enjoyable = {
      amountType: d.enjoyable.amountType,
      realDiscount: d.enjoyable.realDiscount,
      balance: d.enjoyable.balance,
    };
  }
  return out;
}
