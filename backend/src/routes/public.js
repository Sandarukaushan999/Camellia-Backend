import express from "express";
import pool from "../db.js";

const router = express.Router();

const ORDER_TYPES = new Set(["DINE-IN", "TAKEAWAY", "DELIVERY"]);
const PAYMENT_METHODS = new Set(["CASH", "CARD", "QR", "ONLINE", "OTHER"]);

function parsePositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseMoney(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.round(parsed * 100) / 100;
}

function normalizeBranchCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 40);
}

function normalizePhone(value) {
  return String(value || "")
    .replace(/[^\d+]/g, "")
    .trim()
    .slice(0, 30);
}

function normalizeEmail(value) {
  const email = String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 120);
  if (!email) {
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}

function normalizeText(value, maxLength = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeOrderType(value) {
  const normalized = String(value || "DINE-IN")
    .trim()
    .toUpperCase();
  return ORDER_TYPES.has(normalized) ? normalized : "DINE-IN";
}

function normalizePaymentMethod(value) {
  const normalized = String(value || "CASH")
    .trim()
    .toUpperCase();
  return PAYMENT_METHODS.has(normalized) ? normalized : "CASH";
}

function normalizeCategory(value) {
  const category = normalizeText(value, 60);
  return category || "Other";
}

async function findActiveCustomerByPhone(client, phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return null;
  }
  const { rows } = await client.query(
    `SELECT id, full_name, phone, email, address
     FROM customers
     WHERE phone = $1
       AND is_active = TRUE
     LIMIT 1`,
    [normalizedPhone]
  );
  return rows[0] || null;
}

async function upsertQrCustomerRequest(
  client,
  {
    branchId,
    heldOrderId,
    customerName,
    customerPhone,
    customerEmail,
    customerAddress,
    meta = {},
  }
) {
  const normalizedPhone = normalizePhone(customerPhone);
  if (!normalizedPhone) {
    return null;
  }

  const safeMeta =
    meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};

  const existingRes = await client.query(
    `SELECT id
     FROM qr_customer_requests
     WHERE customer_phone = $1
       AND COALESCE(branch_id, 1) = $2
       AND status = 'PENDING'
     ORDER BY requested_at DESC
     LIMIT 1
     FOR UPDATE`,
    [normalizedPhone, Number(branchId || 1)]
  );
  const existing = existingRes.rows[0];

  if (existing) {
    const { rows } = await client.query(
      `UPDATE qr_customer_requests
       SET held_order_id = $2,
           customer_name = $3,
           customer_email = $4,
           customer_address = $5,
           request_count = COALESCE(request_count, 0) + 1,
           last_order_at = NOW(),
           requested_at = NOW(),
           updated_at = NOW(),
           meta = COALESCE(meta, '{}'::jsonb) || $6::jsonb
       WHERE id = $1
       RETURNING id, status`,
      [
        Number(existing.id),
        Number(heldOrderId || 0) || null,
        customerName,
        customerEmail || null,
        customerAddress || null,
        JSON.stringify(safeMeta),
      ]
    );
    return rows[0] || null;
  }

  const { rows } = await client.query(
    `INSERT INTO qr_customer_requests (
       branch_id,
       held_order_id,
       source,
       customer_name,
       customer_phone,
       customer_email,
       customer_address,
       status,
       request_count,
       meta,
       requested_at,
       last_order_at,
       updated_at
     )
     VALUES ($1, $2, 'QR_MENU', $3, $4, $5, $6, 'PENDING', 1, $7::jsonb, NOW(), NOW(), NOW())
     RETURNING id, status`,
    [
      Number(branchId || 1),
      Number(heldOrderId || 0) || null,
      customerName,
      normalizedPhone,
      customerEmail || null,
      customerAddress || null,
      JSON.stringify(safeMeta),
    ]
  );
  return rows[0] || null;
}

async function resolvePublicBranch(client, { branchId = null, branchCode = "" } = {}) {
  const normalizedBranchCode = normalizeBranchCode(branchCode);
  const parsedBranchId = parsePositiveInt(branchId, NaN, 1, 1_000_000);

  if (Number.isFinite(parsedBranchId)) {
    const byId = await client.query(
      `SELECT id, code, name, timezone
       FROM branches
       WHERE id = $1
         AND is_active = TRUE
       LIMIT 1`,
      [parsedBranchId]
    );
    if (byId.rows[0]) {
      return byId.rows[0];
    }
  }

  if (normalizedBranchCode) {
    const byCode = await client.query(
      `SELECT id, code, name, timezone
       FROM branches
       WHERE UPPER(code) = $1
         AND is_active = TRUE
       LIMIT 1`,
      [normalizedBranchCode]
    );
    if (byCode.rows[0]) {
      return byCode.rows[0];
    }
  }

  const fallback = await client.query(
    `SELECT id, code, name, timezone
     FROM branches
     WHERE is_active = TRUE
     ORDER BY id ASC
     LIMIT 1`
  );
  return fallback.rows[0] || null;
}

async function fetchBranchMenuProducts(client, branchId) {
  const { rows } = await client.query(
    `SELECT
       p.id::text AS id,
       p.name,
       p.category,
       p.image_url,
       COALESCE(bp.price_override, p.price) AS price,
       CASE
         WHEN bp.id IS NULL THEN p."isActive"
         ELSE bp.is_active
       END AS is_active
     FROM products p
     LEFT JOIN branch_products bp
       ON bp.branch_id = $1
      AND bp.product_id = p.id::text
     ORDER BY p.category NULLS LAST, p.name ASC`,
    [branchId]
  );

  return rows
    .map((row) => ({
      id: String(row.id),
      name: normalizeText(row.name || `Item ${row.id}`, 120),
      category: normalizeCategory(row.category),
      image_url: row.image_url || null,
      price: parseMoney(row.price, 0),
      is_active: row.is_active === true,
    }))
    .filter((item) => item.is_active && Number.isFinite(item.price) && item.price > 0);
}

function formatQrOrderReference(id) {
  const parsed = Number.parseInt(id, 10);
  const safeId = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return `QRM${String(safeId).padStart(6, "0")}`;
}

function formatQrInvoiceNumber(id) {
  const parsed = Number.parseInt(id, 10);
  const safeId = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return `VOXO${String(safeId).padStart(6, "0")}`;
}

router.get("/menu", async (req, res) => {
  const requestedBranchCode = normalizeBranchCode(
    req.query.branch_code ?? req.query.branchCode
  );
  const requestedBranchId = parsePositiveInt(
    req.query.branch_id ?? req.query.branchId,
    NaN,
    1,
    1_000_000
  );

  const client = await pool.connect();
  try {
    const branch = await resolvePublicBranch(client, {
      branchId: requestedBranchId,
      branchCode: requestedBranchCode,
    });
    if (!branch) {
      return res.status(404).json({ message: "No active branch found" });
    }

    const items = await fetchBranchMenuProducts(client, branch.id);
    const categoryMap = new Map();
    items.forEach((item) => {
      if (!categoryMap.has(item.category)) {
        categoryMap.set(item.category, []);
      }
      categoryMap.get(item.category).push(item);
    });

    const categories = Array.from(categoryMap.entries()).map(([name, categoryItems]) => ({
      name,
      count: categoryItems.length,
      items: categoryItems,
    }));

    return res.json({
      branch: {
        id: Number(branch.id),
        code: branch.code,
        name: branch.name,
        timezone: branch.timezone || "Asia/Colombo",
      },
      generated_at: new Date().toISOString(),
      categories,
      items,
    });
  } catch (err) {
    console.error("Failed to load public menu:", err);
    return res.status(500).json({ message: "Failed to load menu" });
  } finally {
    client.release();
  }
});

router.get("/customer-profile", async (req, res) => {
  const customerPhone = normalizePhone(req.query.phone);
  if (!customerPhone || customerPhone.length < 7) {
    return res.status(400).json({ message: "Valid phone is required" });
  }

  const client = await pool.connect();
  try {
    const customer = await findActiveCustomerByPhone(client, customerPhone);
    return res.json({
      customer: customer
        ? {
            id: customer.id,
            full_name: customer.full_name,
            phone: customer.phone,
            email: customer.email || null,
            address: customer.address || null,
          }
        : null,
    });
  } catch (err) {
    console.error("Failed to lookup public customer profile:", err);
    return res.status(500).json({ message: "Failed to lookup customer profile" });
  } finally {
    client.release();
  }
});

router.post("/orders", async (req, res) => {
  const requestedBranchCode = normalizeBranchCode(req.body?.branch_code);
  const requestedBranchId = parsePositiveInt(req.body?.branch_id, NaN, 1, 1_000_000);
  const customerName = normalizeText(req.body?.customer_name, 120);
  const customerPhone = normalizePhone(req.body?.customer_phone);
  const customerEmail = normalizeEmail(req.body?.customer_email);
  const customerAddress = normalizeText(req.body?.customer_address, 500);
  const orderType = normalizeOrderType(req.body?.order_type);
  const tableNumber = normalizeText(req.body?.table_number, 50);
  const note = normalizeText(req.body?.note, 500);
  const paymentMethod = normalizePaymentMethod(req.body?.payment_method);
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!customerName || customerName.length < 2) {
    return res.status(400).json({ message: "customer_name is required" });
  }

  const requestedItems = rawItems
    .map((item) => ({
      product_id: String(item?.product_id || "").trim(),
      qty: parsePositiveInt(item?.qty, NaN, 1, 999),
    }))
    .filter((item) => item.product_id && Number.isFinite(item.qty) && item.qty > 0);

  if (requestedItems.length === 0) {
    return res.status(400).json({ message: "At least one valid item is required" });
  }

  const uniqueProductIds = [...new Set(requestedItems.map((item) => item.product_id))];
  const client = await pool.connect();
  try {
    const branch = await resolvePublicBranch(client, {
      branchId: requestedBranchId,
      branchCode: requestedBranchCode,
    });
    if (!branch) {
      return res.status(404).json({ message: "No active branch found" });
    }

    const menuProducts = await fetchBranchMenuProducts(client, branch.id);
    const productMap = new Map(menuProducts.map((product) => [String(product.id), product]));
    const existingCustomer = customerPhone
      ? await findActiveCustomerByPhone(client, customerPhone)
      : null;

    const missingProducts = uniqueProductIds.filter(
      (productId) => !productMap.has(String(productId))
    );
    if (missingProducts.length > 0) {
      return res.status(400).json({
        message: "Some items are unavailable in the selected menu",
        missing_product_ids: missingProducts.slice(0, 10),
      });
    }

    const heldItems = requestedItems.map((item) => {
      const product = productMap.get(String(item.product_id));
      return {
        product_id: String(product.id || "").trim(),
        name: product.name,
        category: product.category,
        qty: item.qty,
        price: parseMoney(product.price, 0),
      };
    });

    const estimatedTotal = parseMoney(
      heldItems.reduce((sum, item) => sum + item.qty * parseMoney(item.price, 0), 0),
      0
    );

    await client.query("BEGIN");
    const heldRes = await client.query(
      `INSERT INTO held_orders (
         branch_id,
         order_type,
         table_number,
         customer_name,
         customer_phone,
         items,
         meta,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NULL)
       RETURNING id, created_at`,
      [
        Number(branch.id),
        orderType,
        tableNumber || null,
        customerName,
        customerPhone || null,
        JSON.stringify(heldItems),
        JSON.stringify({
          source: "QR_MENU",
          channel: "WEB",
          payment_method: paymentMethod,
          note: note || null,
          customer_email: customerEmail || null,
          customer_address: customerAddress || null,
          crm_customer_id: existingCustomer?.id || null,
          crm_customer_status: existingCustomer ? "MATCHED" : "PENDING_APPROVAL",
          estimated_total: estimatedTotal,
        }),
      ]
    );
    const heldOrder = heldRes.rows[0];
    const invoiceNumber = formatQrInvoiceNumber(heldOrder.id);
    const reference = formatQrOrderReference(heldOrder.id);

    await client.query(
      `UPDATE held_orders
       SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [
        heldOrder.id,
        JSON.stringify({
          invoice_number: invoiceNumber,
          reference,
        }),
      ]
    );

    let customerRequest = null;
    if (customerPhone && !existingCustomer) {
      customerRequest = await upsertQrCustomerRequest(client, {
        branchId: Number(branch.id),
        heldOrderId: Number(heldOrder.id),
        customerName,
        customerPhone,
        customerEmail,
        customerAddress,
        meta: {
          source: "QR_MENU",
          payment_method: paymentMethod,
          table_number: tableNumber || null,
          note: note || null,
          invoice_number: invoiceNumber,
          reference,
        },
      });
    }

    await client.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, actor_id, actor_role, payload)
       VALUES ('QR_ORDER_CREATE', 'held_order', $1, NULL, 'CUSTOMER', $2::jsonb)`,
      [
        String(heldOrder.id),
        JSON.stringify({
          branch_id: Number(branch.id),
          customer_name: customerName,
          customer_phone: customerPhone || null,
          items_count: heldItems.length,
          estimated_total: estimatedTotal,
          source: "QR_MENU",
          crm_customer_id: existingCustomer?.id || null,
          customer_request_id: customerRequest?.id || null,
        }),
      ]
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Order submitted successfully",
      reference,
      invoice_number: invoiceNumber,
      held_order_id: Number(heldOrder.id),
      crm_customer_id: existingCustomer?.id || null,
      customer_request_id: customerRequest?.id || null,
      customer_request_status: customerRequest?.status || null,
      created_at: heldOrder.created_at,
      branch: {
        id: Number(branch.id),
        code: branch.code,
        name: branch.name,
      },
      estimated_total: estimatedTotal,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    console.error("Failed to create QR menu order:", err);
    return res.status(500).json({ message: "Failed to submit order" });
  } finally {
    client.release();
  }
});

export default router;
