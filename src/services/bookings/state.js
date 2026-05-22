const STATUSES = Object.freeze([
  'requested',
  'confirmed',
  'rejected',
  'cancelled',
  'expired',
  'completed',
]);

const TRANSITIONS = Object.freeze({
  requested: Object.freeze(['confirmed', 'rejected', 'cancelled', 'expired']),
  confirmed: Object.freeze([]),
  rejected: Object.freeze([]),
  cancelled: Object.freeze([]),
  expired: Object.freeze([]),
  completed: Object.freeze([]),
});

class BookingTransitionError extends Error {
  constructor(fromStatus, toStatus) {
    super(`Cannot transition booking from ${fromStatus || 'unknown'} to ${toStatus || 'unknown'}`);
    this.name = 'BookingTransitionError';
    this.code = 'INVALID_TRANSITION';
    this.statusCode = 409;
    this.current_status = fromStatus || null;
    this.target_status = toStatus || null;
  }
}

function isAllowedTransition(fromStatus, toStatus) {
  const allowed = TRANSITIONS[fromStatus];
  return Array.isArray(allowed) && allowed.includes(toStatus);
}

function requireTransition(fromStatus, toStatus) {
  if (!isAllowedTransition(fromStatus, toStatus)) {
    throw new BookingTransitionError(fromStatus, toStatus);
  }
  return true;
}

module.exports = {
  STATUSES,
  TRANSITIONS,
  BookingTransitionError,
  isAllowedTransition,
  requireTransition,
};
