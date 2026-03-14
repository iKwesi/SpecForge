import { getOrdersRoute } from "../api/routes.js";

export function renderOrderSummary(): string {
  const response = getOrdersRoute();
  return response.orders.map((order) => `${order.orderId}:${order.status}`).join(", ");
}

if (process.argv[1]?.endsWith("main.ts")) {
  process.stdout.write(`${renderOrderSummary()}\n`);
}
