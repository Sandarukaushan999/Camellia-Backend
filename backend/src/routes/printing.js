import express from "express";
import net from "net";
import auth from "../middleware/auth.js";
import authorize from "../middleware/authorize.js";

const router = express.Router();

const DEFAULT_PORT = 9100;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_PAPER_SIZE = "80mm";
const DEFAULT_MODEL = "XPrinter XP-80T";
const DEFAULT_CHARS_PER_LINE_80MM = 42;
const DEFAULT_CHARS_PER_LINE_58MM = 32;
const MIN_CHARS_PER_LINE = 32;
const MAX_CHARS_PER_LINE = 48;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

function formatMoney(value) {
  return toNumber(value, 0).toFixed(2);
}

function resolveInvoiceNumber(receipt) {
  const explicit = normalizeText(receipt?.invoiceNo || receipt?.invoice_number || "");
  if (explicit) {
    return explicit;
  }
  const numericPart = String(receipt?.billNo || "")
    .replace(/[^\d]/g, "")
    .padStart(6, "0")
    .slice(-6);
  return `VOXO${numericPart}`;
}

function repeat(char, count) {
  return String(char || " ").repeat(Math.max(0, count));
}

function padLeft(text, width) {
  const normalized = normalizeText(text);
  if (width <= 0) return "";
  if (normalized.length >= width) return normalized.slice(-width);
  return `${repeat(" ", width - normalized.length)}${normalized}`;
}

function padRight(text, width) {
  const normalized = normalizeText(text);
  if (width <= 0) return "";
  if (normalized.length >= width) return normalized.slice(0, width);
  return `${normalized}${repeat(" ", width - normalized.length)}`;
}

function alignCenter(text, width) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  if (normalized.length >= width) return normalized.slice(0, width);
  const padLeft = Math.floor((width - normalized.length) / 2);
  return `${repeat(" ", padLeft)}${normalized}`;
}

function alignLeftRight(left, right, width) {
  const leftText = normalizeText(left);
  const rightText = normalizeText(right);

  if (!rightText) {
    return leftText.slice(0, width);
  }

  if (!leftText) {
    return rightText.slice(0, width);
  }

  const total = leftText.length + rightText.length;
  if (total < width) {
    return `${leftText}${repeat(" ", width - total)}${rightText}`;
  }

  const availableLeft = Math.max(1, width - rightText.length - 1);
  return `${leftText.slice(0, availableLeft)} ${rightText}`;
}

function formatQty(value) {
  const qty = toNumber(value, 0);
  if (Number.isInteger(qty)) {
    return String(qty);
  }
  return qty.toFixed(2).replace(/\.?0+$/, "");
}

function getItemColumns(width) {
  const amountWidth = width >= 42 ? 10 : 8;
  const rateWidth = width >= 42 ? 9 : 8;
  const qtyWidth = 4;
  const nameWidth = Math.max(10, width - amountWidth - rateWidth - qtyWidth - 3);
  return {
    nameWidth,
    qtyWidth,
    rateWidth,
    amountWidth,
  };
}

function wrapText(text, width) {
  const normalized = normalizeText(text);
  if (!normalized || width <= 0) return [];

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = [];
  let current = "";

  const pushChunkedWord = (word) => {
    let cursor = 0;
    while (cursor < word.length) {
      const chunk = word.slice(cursor, cursor + width);
      if (chunk) {
        lines.push(chunk);
      }
      cursor += width;
    }
  };

  for (const rawWord of words) {
    if (rawWord.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      pushChunkedWord(rawWord);
      continue;
    }

    if (!current) {
      current = rawWord;
      continue;
    }

    if (`${current} ${rawWord}`.length <= width) {
      current = `${current} ${rawWord}`;
    } else {
      lines.push(current);
      current = rawWord;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function createSeparator(width, char = "-") {
  return repeat(char, width);
}

function escapeField(value) {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : "-";
}

function buildReceiptLines(receipt, charsPerLine) {
  const width = clamp(charsPerLine, MIN_CHARS_PER_LINE, MAX_CHARS_PER_LINE);
  const lines = [];

  const shopName = escapeField(receipt?.shop?.name || "Camellia Cafe & Restaurant");
  const shopAddress = normalizeText(receipt?.shop?.address || "");
  const shopPhone = normalizeText(receipt?.shop?.phone || "");
  const shopEmail = normalizeText(receipt?.shop?.email || "");

  lines.push(alignCenter(shopName, width));
  wrapText(shopAddress, width).forEach((line) => lines.push(alignCenter(line, width)));
  if (shopPhone || shopEmail) {
    const contact = [shopPhone ? `Tel ${shopPhone}` : "", shopEmail].filter(Boolean).join("  ");
    wrapText(contact, width).forEach((line) => lines.push(alignCenter(line, width)));
  }

  lines.push(createSeparator(width, "-"));
  lines.push(alignLeftRight("Invoice", resolveInvoiceNumber(receipt), width));
  lines.push(alignLeftRight("Date", escapeField(receipt?.date), width));
  lines.push(alignLeftRight("Time", escapeField(receipt?.time), width));
  lines.push(
    alignLeftRight("Order Type", escapeField(receipt?.orderType || "DINE-IN"), width)
  );

  if (receipt?.orderType === "DINE-IN" && receipt?.tableNumber) {
    lines.push(alignLeftRight("Table", escapeField(receipt.tableNumber), width));
  }
  if (receipt?.customerName) {
    lines.push(alignLeftRight("Customer", escapeField(receipt.customerName), width));
  }
  if (receipt?.customerPhone) {
    lines.push(alignLeftRight("Phone", escapeField(receipt.customerPhone), width));
  }
  if (receipt?.note) {
    wrapText(`Note: ${escapeField(receipt.note)}`, width).forEach((line) => lines.push(line));
  }
  lines.push(alignLeftRight("Cashier", escapeField(receipt?.cashier || "System"), width));
  lines.push(createSeparator(width, "-"));

  const items = Array.isArray(receipt?.items) ? receipt.items : [];
  const { nameWidth, qtyWidth, rateWidth, amountWidth } = getItemColumns(width);
  lines.push(
    `${padRight("Item", nameWidth)} ${padLeft("Qty", qtyWidth)} ${padLeft(
      "Rate",
      rateWidth
    )} ${padLeft("Amt", amountWidth)}`
  );
  lines.push(createSeparator(width, "-"));
  items.forEach((item) => {
    const itemName = escapeField(item?.name || "Item");
    const qty = toNumber(item?.qty, 0);
    const unitPrice = toNumber(item?.price, 0);
    const itemTotal = qty * unitPrice;
    const itemNameLines = wrapText(itemName, nameWidth);
    const lineItems = itemNameLines.length > 0 ? itemNameLines : ["Item"];

    lineItems.forEach((line, index) => {
      const qtyText = index === 0 ? padLeft(formatQty(qty), qtyWidth) : repeat(" ", qtyWidth);
      const rateText =
        index === 0 ? padLeft(formatMoney(unitPrice), rateWidth) : repeat(" ", rateWidth);
      const amountText =
        index === 0 ? padLeft(formatMoney(itemTotal), amountWidth) : repeat(" ", amountWidth);
      lines.push(`${padRight(line, nameWidth)} ${qtyText} ${rateText} ${amountText}`);
    });
  });

  lines.push(createSeparator(width, "-"));
  lines.push(alignLeftRight("Items", String(items.length), width));
  lines.push(alignLeftRight("Subtotal", formatMoney(receipt?.subtotal), width));

  if (toNumber(receipt?.serviceCharge, 0) > 0) {
    lines.push(
      alignLeftRight(
        `Service (${toNumber(receipt?.serviceChargePercent, 0)}%)`,
        formatMoney(receipt?.serviceCharge),
        width
      )
    );
  }

  if (toNumber(receipt?.tax, 0) > 0) {
    lines.push(
      alignLeftRight(
        `Tax (${toNumber(receipt?.taxPercent, 0)}%)`,
        formatMoney(receipt?.tax),
        width
      )
    );
  }

  if (toNumber(receipt?.manualDiscount, 0) > 0) {
    lines.push(
      alignLeftRight(
        "Manual Discount",
        `- ${formatMoney(receipt?.manualDiscount)}`,
        width
      )
    );
  }

  if (toNumber(receipt?.loyaltyDiscount, 0) > 0) {
    const points = toNumber(receipt?.loyaltyPointsRedeemed, 0);
    const label = points > 0 ? `Loyalty (${points} pts)` : "Loyalty Redeem";
    lines.push(
      alignLeftRight(label, `- ${formatMoney(receipt?.loyaltyDiscount)}`, width)
    );
  }

  if (
    toNumber(receipt?.discount, 0) > 0 &&
    toNumber(receipt?.manualDiscount, 0) <= 0 &&
    toNumber(receipt?.loyaltyDiscount, 0) <= 0
  ) {
    lines.push(alignLeftRight("Discount", `- ${formatMoney(receipt?.discount)}`, width));
  }

  lines.push(createSeparator(width, "="));
  lines.push(alignCenter("TOTAL (LKR)", width));
  lines.push(alignCenter(formatMoney(receipt?.total), width));
  lines.push(createSeparator(width, "="));
  lines.push(alignLeftRight("Payment", escapeField(receipt?.paymentMethod || "CASH"), width));

  if (String(receipt?.paymentMethod || "").toUpperCase() === "CASH") {
    if (toNumber(receipt?.cashGiven, 0) > 0) {
      lines.push(alignLeftRight("Cash Given", formatMoney(receipt?.cashGiven), width));
    }
    lines.push(alignLeftRight("Balance", formatMoney(receipt?.balance), width));
  }

  lines.push(createSeparator(width, "-"));
  // Keep a small visual gap before the VOXOsolutions footer section.
  lines.push("");
  lines.push("");
  [
    "System Design & Powered By",
    "VOXOsolutions.com",
    "(c) 2026 All rights reserved.",
    "ERP / POS / WEBSITE / SOFTWARE SOLUTIONS",
    "0710901871",
    "voxosolution@gmail.com",
    "Thank you for visiting!",
  ].forEach((entry) => {
    wrapText(entry, width).forEach((line) => {
      lines.push(alignCenter(line, width));
    });
  });

  return lines;
}

function toEscPosBuffer(lines) {
  const payload = [];

  // Initialize printer and set code page to CP437 (widely compatible on XP series).
  payload.push(Buffer.from([0x1b, 0x40]));
  payload.push(Buffer.from([0x1b, 0x74, 0x00]));
  payload.push(Buffer.from([0x1b, 0x61, 0x00]));
  payload.push(Buffer.from([0x1b, 0x45, 0x00]));
  payload.push(Buffer.from([0x1d, 0x21, 0x00]));

  lines.forEach((line) => {
    const trimmed = String(line || "").trim();
    const isTotalLabel = trimmed === "TOTAL (LKR)";
    const isTotalValue = /^\d+(?:\.\d{2})$/.test(trimmed);
    const isFooterTitle = trimmed === "System Design & Powered By";

    if (isTotalLabel || isTotalValue) {
      // Emphasize total section for high visibility.
      payload.push(Buffer.from([0x1b, 0x45, 0x01]));
      payload.push(Buffer.from([0x1d, 0x21, 0x01]));
    } else if (isFooterTitle) {
      payload.push(Buffer.from([0x1b, 0x45, 0x01]));
      payload.push(Buffer.from([0x1d, 0x21, 0x00]));
    } else {
      payload.push(Buffer.from([0x1b, 0x45, 0x00]));
      payload.push(Buffer.from([0x1d, 0x21, 0x00]));
    }

    payload.push(Buffer.from(`${line}\r\n`, "ascii"));
  });

  // Reset font scaling/emphasis before cut.
  payload.push(Buffer.from([0x1d, 0x21, 0x00]));
  payload.push(Buffer.from([0x1b, 0x45, 0x00]));
  // Feed enough paper so long footer lines are fully visible before cut.
  payload.push(Buffer.from([0x1b, 0x64, 0x08]));
  payload.push(Buffer.from([0x1d, 0x56, 0x00]));

  return Buffer.concat(payload);
}

function sendRawTcp({ host, port, buffer, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let writeDone = false;

    const safeResolve = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const safeReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      safeReject(new Error("Printer connection timed out"));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(buffer, (error) => {
        if (error) {
          socket.destroy();
          safeReject(error);
          return;
        }

        writeDone = true;
        socket.end();
      });
    });

    socket.on("error", (error) => {
      socket.destroy();
      safeReject(error);
    });

    socket.on("close", () => {
      if (writeDone) {
        safeResolve();
      } else if (!settled) {
        safeReject(new Error("Printer connection closed before write completed"));
      }
    });
  });
}

router.post("/escpos", auth, authorize("ADMIN", "CASHIER"), async (req, res) => {
  try {
    const printer = req.body?.printer || {};
    const receipt = req.body?.receipt || {};
    const requestedModel = normalizeText(printer.model || DEFAULT_MODEL).toUpperCase();
    const isXp80T = requestedModel.includes("XP-80T") || requestedModel.includes("XP80T");

    const host = normalizeText(printer.host || "");
    const port = clamp(
      Math.round(toNumber(printer.port, DEFAULT_PORT)),
      1,
      65535
    );
    const timeoutMs = clamp(
      Math.round(toNumber(printer.timeoutMs, DEFAULT_TIMEOUT_MS)),
      1000,
      15000
    );

    const paperSize = isXp80T
      ? "80mm"
      : String(printer.paperSize || DEFAULT_PAPER_SIZE).toLowerCase() === "58mm"
        ? "58mm"
        : "80mm";
    const charsPerLine = isXp80T
      ? DEFAULT_CHARS_PER_LINE_80MM
      : clamp(
          Math.round(
            toNumber(
              printer.charsPerLine,
              paperSize === "58mm"
                ? DEFAULT_CHARS_PER_LINE_58MM
                : DEFAULT_CHARS_PER_LINE_80MM
            )
          ),
          MIN_CHARS_PER_LINE,
          MAX_CHARS_PER_LINE
        );

    if (!host) {
      return res.status(400).json({
        message: "Printer host is required for direct ESC/POS printing",
      });
    }

    const lines = buildReceiptLines(receipt, charsPerLine);
    const commandBuffer = toEscPosBuffer(lines);

    await sendRawTcp({
      host,
      port,
      buffer: commandBuffer,
      timeoutMs,
    });

    return res.json({
      message: "Receipt sent to printer",
      mode: "ESC_POS_TCP",
      model: isXp80T ? DEFAULT_MODEL : requestedModel || DEFAULT_MODEL,
      host,
      port,
      paperSize,
      charsPerLine,
      bytes: commandBuffer.length,
    });
  } catch (error) {
    console.error("ESC/POS print failed:", error);
    return res.status(500).json({
      message: "Failed to send receipt to ESC/POS printer",
      error: error?.message || "Unknown printing error",
    });
  }
});

export default router;
