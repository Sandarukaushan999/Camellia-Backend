function normalizePermissionList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((permission) => String(permission || "").trim())
    .filter(Boolean);
}

export function userHasPermissions(user, requiredPermissions = []) {
  const required = normalizePermissionList(requiredPermissions);
  if (required.length === 0) {
    return true;
  }
  if (!user) {
    return false;
  }

  const granted = new Set(normalizePermissionList(user.permissions));
  // Backward compatibility for older admin tokens that do not carry permissions yet.
  if (String(user.role || "").toUpperCase() === "ADMIN" && granted.size === 0) {
    return true;
  }

  return required.every((permission) => granted.has(permission));
}

export function authorizePermissions(...requiredPermissions) {
  return (req, res, next) => {
    if (!userHasPermissions(req.user, requiredPermissions)) {
      return res.status(403).json({ message: "Access denied" });
    }
    return next();
  };
}

export default function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied" });
    }
    return next();
  };
}





