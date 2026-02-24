export const LOYALTY_EARN_STEP = 100; // 1 point per Rs. 100
export const LOYALTY_POINT_VALUE = 1; // 1 point = Rs. 1 discount
export const LOYALTY_MAX_REDEEM_PERCENT = 0.2; // max 20% of bill
export const LOYALTY_MIN_REDEEM_POINTS = 10;

export function computeMaxRedeemablePoints(availablePoints, orderTotal) {
  const maxByTotal = Math.floor(
    (Math.max(0, Number(orderTotal) || 0) * LOYALTY_MAX_REDEEM_PERCENT) / LOYALTY_POINT_VALUE
  );
  return Math.max(0, Math.min(Math.max(0, Number(availablePoints) || 0), maxByTotal));
}

export function computeEarnedPoints(orderTotal) {
  return Math.max(0, Math.floor((Math.max(0, Number(orderTotal) || 0)) / LOYALTY_EARN_STEP));
}
