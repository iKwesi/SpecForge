import { listOrderSummaries } from "./service.js";

export function getOrdersRoute(): { orders: ReturnType<typeof listOrderSummaries> } {
  return {
    orders: listOrderSummaries()
  };
}
