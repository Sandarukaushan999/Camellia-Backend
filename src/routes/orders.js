import express from "express";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";
import pool from "../db.js";

const router = express.Router();

// POS order creation (both ADMIN and CASHIER)
router.post("/", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  const { total, payment_method: paymentMethod, items = [] } = req.body;
  if (!total || !paymentMethod || !Array.isArray(items) || items.length === 0) {
    return res
      .status(400)
      .json({ message: "Total, payment method, and items are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderResult = await client.query(
      "INSERT INTO orders (total, payment_method) VALUES ($1, $2) RETURNING id",
      [total, paymentMethod]
    );
    const orderId = orderResult.rows[0].id;

    const insertItems = items.map((item) =>
      client.query(
        "INSERT INTO order_items (order_id, product_id, qty, price) VALUES ($1, $2, $3, $4)",
        [orderId, item.product_id, item.qty, item.price]
      )
    );
    await Promise.all(insertItems);

    await client.query("COMMIT");
    return res.status(201).json({ id: orderId });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ message: "Could not create order" });
  } finally {
    client.release();
  }
});

export default router;





