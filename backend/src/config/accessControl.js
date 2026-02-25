export const PERMISSION_DEFINITIONS = [
  {
    key: "dashboard.view",
    module: "dashboard",
    label: "Dashboard View",
    description: "Access operational dashboard KPIs and activity stream.",
  },
  {
    key: "pos.view",
    module: "pos",
    label: "POS View",
    description: "Open POS billing screen and view catalog.",
  },
  {
    key: "pos.checkout",
    module: "pos",
    label: "POS Checkout",
    description: "Place and complete orders from POS.",
  },
  {
    key: "sales.view",
    module: "sales",
    label: "Sales View",
    description: "View invoice ledger and sales transactions.",
  },
  {
    key: "products.view",
    module: "products",
    label: "Products View",
    description: "View products and product setup.",
  },
  {
    key: "products.manage",
    module: "products",
    label: "Products Manage",
    description: "Create, edit, and deactivate products.",
  },
  {
    key: "inventory.view",
    module: "inventory",
    label: "Inventory View",
    description: "View inventory, stock levels, and alerts.",
  },
  {
    key: "inventory.manage",
    module: "inventory",
    label: "Inventory Manage",
    description: "Update stock, recipes, and supply operations.",
  },
  {
    key: "expenses.view",
    module: "expenses",
    label: "Expenses View",
    description: "View expense records and summaries.",
  },
  {
    key: "expenses.manage",
    module: "expenses",
    label: "Expenses Manage",
    description: "Create and edit expense entries.",
  },
  {
    key: "reports.view",
    module: "reports",
    label: "Reports View",
    description: "Access reports and performance analytics.",
  },
  {
    key: "crm.view",
    module: "crm",
    label: "CRM View",
    description: "Access customers, loyalty, campaigns, and follow-ups.",
  },
  {
    key: "settings.view",
    module: "settings",
    label: "Settings View",
    description: "Access system settings and configuration pages.",
  },
  {
    key: "users.view",
    module: "users",
    label: "Users View",
    description: "View user management data.",
  },
  {
    key: "users.manage",
    module: "users",
    label: "Users Manage",
    description: "Create users, edit users, and reset credentials.",
  },
  {
    key: "roles.manage",
    module: "users",
    label: "Roles Manage",
    description: "Create and configure custom roles and permissions.",
  },
  {
    key: "branches.manage",
    module: "operations",
    label: "Branches Manage",
    description: "Manage branches and branch assignments.",
  },
  {
    key: "supply.view",
    module: "supply",
    label: "Supply View",
    description: "View suppliers, requisitions, and purchase orders.",
  },
  {
    key: "supply.manage",
    module: "supply",
    label: "Supply Manage",
    description: "Create and approve requisitions or purchase operations.",
  },
  {
    key: "operations.view",
    module: "operations",
    label: "Operations View",
    description: "View operations workflows and controls.",
  },
  {
    key: "analytics.view",
    module: "analytics",
    label: "Analytics View",
    description: "Access advanced analytics endpoints.",
  },
  {
    key: "backup.manage",
    module: "settings",
    label: "Backup Manage",
    description: "Run backup, restore, and reset operations.",
  },
];

export const ALL_PERMISSION_KEYS = PERMISSION_DEFINITIONS.map(
  (permission) => permission.key
);

const PERMISSION_KEY_SET = new Set(ALL_PERMISSION_KEYS);

export function normalizePermissionKeys(rawPermissions) {
  const source = Array.isArray(rawPermissions) ? rawPermissions : [];
  const unique = new Set();
  for (const permission of source) {
    const key = String(permission || "").trim();
    if (PERMISSION_KEY_SET.has(key)) {
      unique.add(key);
    }
  }
  return [...unique];
}

export function buildPermissionMapFromKeys(rawPermissions) {
  const granted = new Set(normalizePermissionKeys(rawPermissions));
  const map = {};
  for (const key of ALL_PERMISSION_KEYS) {
    map[key] = granted.has(key);
  }
  return map;
}

export function getDefaultPermissionKeysForBaseRole(baseRole) {
  const normalizedRole = String(baseRole || "").trim().toUpperCase();
  if (normalizedRole === "ADMIN") {
    return [...ALL_PERMISSION_KEYS];
  }
  if (normalizedRole === "CASHIER") {
    return ["pos.view", "pos.checkout", "sales.view"];
  }
  return [];
}

export function getDefaultPermissionMapForBaseRole(baseRole) {
  return buildPermissionMapFromKeys(getDefaultPermissionKeysForBaseRole(baseRole));
}
