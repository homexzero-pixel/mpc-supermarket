/**
 * POS integration boundary. The storefront never completes a sale itself; it
 * hands a HELD basket to the POS and lets the POS finalise payment, receipt
 * numbering, pricing/rounding/tax and stock movement.
 */

export interface PosCatalogueItem {
  pos_item_id: string;
  name_en: string;
  name_ta?: string | null;
  brand?: string | null;
  department?: string | null;
  pack_label?: string | null;
  sold_by: 'pack' | 'piece' | 'weight';
  price_paise: number;          // per unit, or per kg for weight
  mrp_paise?: number | null;
  barcodes: string[];
  available: boolean;
  group_key?: string | null;
  max_qty?: number | null;
  aliases?: string | null;
  image_url?: string | null;
}

export interface PosLine {
  line_ref: string;             // our order_line id, stable across retries
  pos_item_id: string;
  qty: number;
  grams?: number | null;        // weighed or estimated grams for weight items
  weighed: boolean;             // true when grams are actual counter weights
  unit_price_paise: number;     // price shown to the customer (POS may re-price)
}

export interface HeldBasketRequest {
  external_ref: string;         // our order id
  request_key: string;          // idempotency key for this delivery
  branch_id: string;
  counter_number: number | null;
  order_code: string;
  lines: PosLine[];
}

export interface FinalizeRequest {
  pos_ref: string;
  attempt_key: string;          // idempotency key for this payment attempt
  lines: PosLine[];
  method: 'cash' | 'upi' | 'card' | 'other';
  cashier: string;
}

export interface SaleResult {
  sale_id: string;
  receipt_no: string;
  total_paise: number;          // authoritative, after POS pricing/rounding
  round_off_paise: number;
  pos_ref: string;
  attempt_key: string;
}

export class PosError extends Error {
  /** uncertain = the request may or may not have been applied (timeout, dropped connection). */
  constructor(message: string, public uncertain: boolean, public code = 'POS_ERROR') {
    super(message);
  }
}

export interface PosAdapter {
  readonly name: string;
  health(): Promise<{ ok: boolean; detail: string }>;
  fetchCatalogue(): Promise<PosCatalogueItem[]>;
  createHeldBasket(req: HeldBasketRequest): Promise<{ pos_ref: string }>;
  findHeldBasket(external_ref: string): Promise<{ pos_ref: string; status: string } | null>;
  updateHeldBasket(pos_ref: string, lines: PosLine[]): Promise<void>;
  voidHeldBasket(pos_ref: string, reason: string): Promise<void>;
  finalizeSale(req: FinalizeRequest): Promise<SaleResult>;
  /** Look up a payment attempt before ever allowing another charge. */
  lookupSale(attempt_key: string): Promise<SaleResult | null>;
  listSalesSince(iso: string): Promise<SaleResult[]>;
}
