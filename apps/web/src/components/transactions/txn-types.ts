import type { StoredItemLines } from "@finance/shared/src/receipt-items";

export interface TxnRow {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  merchant: string | null;
  merchant_clean: string | null;
  description: string | null;
  category_id: string | null;
  category_source: string | null;
  pending: boolean;
  hidden: boolean;
  needs_review: boolean;
  is_business: boolean;
  business_entity: string | null;
  receipt_status: string | null;
  parent_transaction_id: string | null;
  /** The receipt's basket, when one was parsed — see StoredItemLines. */
  item_lines: StoredItemLines | null;
  accounts?: { name: string } | null;
}
