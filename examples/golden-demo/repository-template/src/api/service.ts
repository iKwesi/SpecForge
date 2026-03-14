export interface OrderSummary {
  orderId: string;
  status: "pending" | "ready";
  totalItems: number;
}

export function listOrderSummaries(): OrderSummary[] {
  return [
    {
      orderId: "order-1",
      status: "ready",
      totalItems: 3
    }
  ];
}
