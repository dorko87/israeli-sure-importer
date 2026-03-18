// Shared types that mirror what israeli-bank-scrapers returns at runtime.
// Defined locally to avoid depending on the library's exported type names.

export interface Transaction {
  type?: string; // 'normal' | 'installments' in the library
  identifier?: string | number;
  date: string;
  processedDate?: string;
  description: string;
  memo?: string;
  chargedAmount: number;
  originalAmount?: number;
  originalCurrency?: string;
  status: string; // 'completed' | 'pending'
  installments?: {
    number: number;
    total: number;
  };
}

export interface ScraperAccount {
  accountNumber: string;
  balance?: number;
  txns: Transaction[];
}

export interface ScraperSuccess {
  success: true;
  accounts: ScraperAccount[];
}

export interface ScraperFailure {
  success: false;
  errorType: string;
  errorMessage?: string;
}

export type ScrapeResult = ScraperSuccess | ScraperFailure;
