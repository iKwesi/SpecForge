import { getOrdersRoute } from "../api/routes.js";

export function renderOrderSummary(): string {
  const response = getOrdersRoute();
  return response.orders.map((order) => `${order.orderId}:${order.status}`).join(", ");
}
