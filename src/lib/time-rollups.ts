export type TimeRollupGroup = "project" | "client" | "task";
export interface TimeRollup {
  id: string;
  seconds: number;
  billableCents: number;
  uninvoicedCents: number;
  costCents?: number;
}
