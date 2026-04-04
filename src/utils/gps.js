/**
 * ═══════════════════════════════════════════════════════════════════
 *  Server-side GPS filtering — mirrors frontend logic.
 *  Kalman filter only, no sliding window or extra smoothing.
 * ═══════════════════════════════════════════════════════════════════
 */

const MAX_SPEED_MS = 70;          // ~252 km/h — match frontend
const STATIONARY_THRESHOLD = 2;   // meters — match frontend MIN_MOVEMENT
const MAX_JUMP_DIST = 500;        // meters — match frontend MAX_JUMP
const MAX_DT = 10;                // seconds — clamp time gap
const ACCURACY_THRESHOLD = 100;   // meters — match frontend MAX_ACCURACY

// ── 2D Kalman Filter ────────────────────────────────────────────────
class KalmanFilter2D {
  constructor() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    this.Q = 0.00001;
    this.R = 0.0001;
    this.stationaryCount = 0;
  }

  update(measurement, dt, accuracy, isStationary = false) {
    if (!this.x) {
      this.x = [...measurement];
      return this.x;
    }

    if (isStationary) {
      this.stationaryCount++;
      if (this.stationaryCount >= 3) {
        this.v = [0, 0];
      } else {
        this.v = [this.v[0] * 0.2, this.v[1] * 0.2];
      }
    } else {
      this.stationaryCount = 0;
    }

    const predicted = [
      this.x[0] + this.v[0] * dt,
      this.x[1] + this.v[1] * dt,
    ];
    const predictedP = this.P + this.Q;

    const adaptiveR = this.R * Math.max(1, accuracy / 5);
    const K = predictedP / (predictedP + adaptiveR);

    this.x = [
      predicted[0] + K * (measurement[0] - predicted[0]),
      predicted[1] + K * (measurement[1] - predicted[1]),
    ];

    if (dt > 0 && !isStationary) {
      this.v = [
        (this.x[0] - predicted[0] + this.v[0] * dt) / dt,
        (this.x[1] - predicted[1] + this.v[1] * dt) / dt,
      ];
    }

    this.P = (1 - K) * predictedP;
    return this.x;
  }

  reset() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
    this.stationaryCount = 0;
  }
}

// ── Haversine Distance ──────────────────────────────────────────────
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Process Location — matches frontend processLocation exactly ────
function processLocation(newLat, newLng, prevEntry, kalman, accuracy = null, timestamp = null) {
  if (typeof newLat !== 'number' || typeof newLng !== 'number' ||
      newLat < -90 || newLat > 90 || newLng < -180 || newLng > 180) {
    return null;
  }

  const normalizedAccuracy = (typeof accuracy === 'number' && isFinite(accuracy))
    ? accuracy : ACCURACY_THRESHOLD;

  if (normalizedAccuracy <= 0 || normalizedAccuracy > ACCURACY_THRESHOLD) return null;

  const now = timestamp || Date.now();

  if (!prevEntry) {
    const filtered = kalman.update([newLat, newLng], 1, normalizedAccuracy);
    return {
      latitude: filtered[0],
      longitude: filtered[1],
      timestamp: now,
    };
  }

  const dt = Math.min((now - prevEntry.timestamp) / 1000, MAX_DT);
  if (dt <= 0) return null;

  const rawDist = haversineDistance(prevEntry.latitude, prevEntry.longitude, newLat, newLng);
  if (rawDist > MAX_JUMP_DIST) return null;

  const rawSpeed = rawDist / dt;
  if (rawSpeed > MAX_SPEED_MS) return null;

  // Dynamic stationary threshold — match frontend
  const dynamicMinMovement = Math.max(STATIONARY_THRESHOLD, normalizedAccuracy * 0.25);

  if (rawDist < dynamicMinMovement) {
    kalman.update([prevEntry.latitude, prevEntry.longitude], dt, normalizedAccuracy, true);
    return { ...prevEntry, timestamp: now };
  }

  // Kalman filter only — no sliding window, no extra smoothing
  const filtered = kalman.update([newLat, newLng], dt, normalizedAccuracy, false);

  const filteredDist = haversineDistance(
    prevEntry.latitude, prevEntry.longitude,
    filtered[0], filtered[1]
  );

  const speed = filteredDist / dt;
  if (speed > MAX_SPEED_MS) return null;

  return {
    latitude: filtered[0],
    longitude: filtered[1],
    timestamp: now,
  };
}

// ── Per-user state cache ────────────────────────────────────────────
const userStates = new Map();

function getUserState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      prev: null,
      kalman: new KalmanFilter2D(),
    });
  }
  return userStates.get(userId);
}

function clearUserState(userId) {
  userStates.delete(userId);
}

module.exports = {
  processLocation,
  getUserState,
  clearUserState,
  haversineDistance,
  KalmanFilter2D,
};
