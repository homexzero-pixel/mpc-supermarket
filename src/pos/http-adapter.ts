import type { FinalizeRequest, HeldBasketRequest, PosAdapter, PosCatalogueItem, PosLine, SaleResult } from './adapter.js';
import { PosError } from './adapter.js';

/**
 * Generic REST adapter for the shop's live POS.
 *
 * >>> CONNECTION POINT <<<
 * The endpoint paths and field names below are a reasonable REST contract, NOT
 * the real POS API (none was supplied). Map each method to the vendor's API
 * once its documentation is available. Every method that changes state sends
 * an Idempotency-Key header; if the vendor has no such feature, keep the
 * look-up-before-retry behaviour (findHeldBasket / lookupSale) which the worker
 * already relies on.
 *
 * Required: POS_BASE_URL, POS_API_KEY (server-side only, never sent to browsers).
 */
export class HttpPosAdapter implements PosAdapter {
  readonly name = 'http';
  constructor(private baseUrl: string, private apiKey: string, private timeoutMs = 8000) {}

  private async call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e: any) {
      const refused = e?.cause?.code === 'ECONNREFUSED' || e?.cause?.code === 'ENOTFOUND';
      // If the connection was refused nothing was sent; otherwise the outcome is unknown.
      throw new PosError(`POS request failed: ${e?.cause?.code ?? e?.name ?? e}`, !refused, refused ? 'POS_DOWN' : 'POS_TIMEOUT');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404 && method === 'GET') return null as T;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 5xx: the POS may have applied the change - treat as uncertain and look up before retrying.
      throw new PosError(`POS ${res.status}: ${text.slice(0, 300)}`, res.status >= 500, `HTTP_${res.status}`);
    }
    return (res.status === 204 ? null : await res.json()) as T;
  }

  async health() {
    try {
      await this.call('GET', '/health');
      return { ok: true, detail: 'POS reachable' };
    } catch (e: any) {
      return { ok: false, detail: e.message };
    }
  }
  fetchCatalogue() {
    return this.call<PosCatalogueItem[]>('GET', '/items?include=barcodes,stock');
  }
  createHeldBasket(req: HeldBasketRequest) {
    return this.call<{ pos_ref: string }>('POST', '/held-baskets', req, req.request_key);
  }
  findHeldBasket(external_ref: string) {
    return this.call<{ pos_ref: string; status: string } | null>('GET', `/held-baskets?external_ref=${encodeURIComponent(external_ref)}`);
  }
  async updateHeldBasket(pos_ref: string, lines: PosLine[]) {
    await this.call('PUT', `/held-baskets/${encodeURIComponent(pos_ref)}/lines`, { lines });
  }
  async voidHeldBasket(pos_ref: string, reason: string) {
    await this.call('POST', `/held-baskets/${encodeURIComponent(pos_ref)}/void`, { reason }, `void-${pos_ref}`);
  }
  finalizeSale(req: FinalizeRequest) {
    return this.call<SaleResult>('POST', `/held-baskets/${encodeURIComponent(req.pos_ref)}/finalize`, req, req.attempt_key);
  }
  lookupSale(attempt_key: string) {
    return this.call<SaleResult | null>('GET', `/sales?attempt_key=${encodeURIComponent(attempt_key)}`);
  }
  listSalesSince(iso: string) {
    return this.call<SaleResult[]>('GET', `/sales?since=${encodeURIComponent(iso)}`);
  }
}
