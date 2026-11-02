const key = (userId) => `hb.tour.patient.${userId}`;

/** Whether this person has finished or put off the tour on this device. */
export function tourSeen(userId) {
  try {
    return localStorage.getItem(key(userId)) === 'seen';
  } catch {
    return false;
  }
}

export function markTourSeen(userId) {
  try {
    localStorage.setItem(key(userId), 'seen');
  } catch {
    // Blocked storage only means the tour is offered again next time.
  }
}
