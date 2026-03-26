function createRequireAdmin({ adminApiKey } = {}) {
  return function requireAdmin(req, res, next) {
    if (!adminApiKey) {
      return res.status(500).json({ error: 'ADMIN_API_KEY_NOT_CONFIGURED' });
    }
    const provided =
      (typeof req.header === 'function' && (req.header('X-ADMIN-KEY') || req.header('x-admin-key'))) ||
      (typeof req.get === 'function' && (req.get('X-ADMIN-KEY') || req.get('x-admin-key'))) ||
      '';
    if (!provided || provided !== adminApiKey) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    return next();
  };
}

module.exports = {
  createRequireAdmin,
};
