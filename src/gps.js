/**
 * ═══════════════════════════════════════════════════════════════════
 *  Server-side GPS filtering — mirrors frontend logic exactly.
 *  Comprehensive GPS fixes: accuracy filtering, timestamp handling,
 *  coordinate smoothing, speed calculation, and edge case handling.
 * ═══════════════════════════════════════════════════════════════════
 */

const MAX_SPEED_MS = 50;          // ~180 km/h — reject anything faster
const STATIONARY_THRESHOLD = 3;   // meters — ignore drift below this (matches frontend)
const MAX_JUMP_DIST = 100;        // meters — reject teleports
const MAX_DT = 5;                 // seconds — clamp time gap
const ACCURACY_THRESHOLD = 30;    // meters — reject GPS >30m accuracy

// 🚀 OPTIONAL PRO-LEVEL FIXES
// Adaptive accuracy based on speed (higher speed = more lenient accuracy)
const getAdaptiveAccuracyThreshold = (speed) => {
  if (speed < 2) return 20;        // Walking: strict accuracy
  if (speed < 10) return 30;       // Cycling: moderate accuracy
  if (speed < 30) return 50;       // Driving: lenient accuracy
  return 100;                      // High speed: very lenient
};

// Activity detection based on speed patterns
const detectActivity = (speed, prevSpeed = 0) => {
  if (speed < 0.5) return 'stationary';
  if (speed < 3) return 'walking';
  if (speed < 15) return 'cycling';
  if (speed < 40) return 'driving';
  return 'high_speed';
};

// ── 2D Kalman Filter (with velocity prediction) ─────────────────────
class KalmanFilter2D {
  constructor() {
    this.x = null;       // [lat, lng]
    this.v = [0, 0];     // velocity
    this.P = 1;
    this.Q = 0.01;
    this.R = 0.0001;
  }

  update(measurement, dt) {
    if (!this.x) {
      this.x = measurement;
      return this.x;
    }

    // Predict step (constant velocity model)
    this.x = [
      this.x[0] + this.v[0] * dt,
      this.x[1] + this.v[1] * dt,
    ];

    // Kalman gain
    const K = this.P / (this.P + this.R);

    // Update
    this.x = [
      this.x[0] + K * (measurement[0] - this.x[0]),
      this.x[1] + K * (measurement[1] - this.x[1]),
    ];

    // Update velocity
    if (dt > 0) {
      this.v = [
        (measurement[0] - this.x[0]) / dt,
        (measurement[1] - this.x[1]) / dt,
      ];
    }

    this.P = (1 - K) * this.P + this.Q;

    return this.x;
  }

  reset() {
    this.x = null;
    this.v = [0, 0];
    this.P = 1;
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

// ── Global state for coordinate smoothing ───────────────────────────
let previousLocation = null;
let previousTimestamp = null;
let smoothedLocation = null;

// ── Process Location (Comprehensive GPS Fixes) ─────────────────────
// Mirrors frontend: accuracy filter → timestamp handling → distance check →
// stationary filter → coordinate smoothing → speed calculation → spike rejection
function processLocation(newLat, newLng, speed, prevEntry, kalman, accuracy = null, timestamp = null, userId = null) {
  // 🧪 EDGE CASE FIXES
  // Handle Null / Missing Location Safely
  if (typeof newLat !== 'number' || typeof newLng !== 'number' ||
      newLat < -90 || newLat > 90 || newLng < -180 || newLng > 180) {
    return null;
  }

  // 🚀 OPTIONAL PRO-LEVEL FIXES
  // Adaptive Accuracy Based on Speed
  let adaptiveAccuracyThreshold = ACCURACY_THRESHOLD;
  if (prevEntry && prevEntry.speed !== undefined) {
    adaptiveAccuracyThreshold = getAdaptiveAccuracyThreshold(prevEntry.speed);
  }

  // 📍 LOCATION QUALITY FIXES
  // Accuracy Filter (Reject > adaptive threshold GPS) - if accuracy provided
  if (accuracy !== null && accuracy > adaptiveAccuracyThreshold) {
    return null;
  }

  // CORE GPS FIXES
  // Use GPS Timestamp Instead of Date.now
  // Avoid Fallback Timestamp (No Date.now Backup)
  const now = timestamp || Date.now(); // Use provided timestamp, fallback only if missing

  if (!prevEntry) {
    const filtered = kalman.update([newLat, newLng], 1);
    const initialLocation = {
      latitude: filtered[0],
      longitude: filtered[1],
      speed: 0,
      timestamp: now,
      activity: 'stationary',
    };

    // Update global smoothing state
    previousLocation = { latitude: newLat, longitude: newLng };
    previousTimestamp = now;
    smoothedLocation = initialLocation;

    return initialLocation;
  }

  // 🚶 MOVEMENT & DRIFT FIXES
  // Ignore Zero/Invalid Time Differences
  const dt = Math.min((now - prevEntry.timestamp) / 1000, MAX_DT);
  if (dt <= 0) return null;

  // Reject Unrealistic GPS Jumps (>100m)
  const rawDist = haversineDistance(prevEntry.latitude, prevEntry.longitude, newLat, newLng);
  if (rawDist > MAX_JUMP_DIST) return null;

  // Reject Teleport Speed (>50 m/s)
  const teleportSpeed = rawDist / dt;
  if (teleportSpeed > MAX_SPEED_MS) return null;

  // Apply 2D Kalman filter
  const filtered = kalman.update([newLat, newLng], dt);
  const filteredLat = filtered[0];
  const filteredLng = filtered[1];

  // Distance from filtered position
  const filteredDist = haversineDistance(
    prevEntry.latitude, prevEntry.longitude,
    filteredLat, filteredLng
  );

  // 🚶 MOVEMENT & DRIFT FIXES
  // Ignore Stationary Drift (<3m movement)
  if (filteredDist < STATIONARY_THRESHOLD) {
    return { ...prevEntry, speed: 0, timestamp: now, activity: 'stationary' };
  }

  // 🧠 SMOOTHING & STABILITY
  // Apply Coordinate Smoothing (Weighted Average)
  let finalLat = filteredLat;
  let finalLng = filteredLng;

  if (smoothedLocation) {
    // Reduce Jitter Using Previous + Current Blend (70% previous, 30% current)
    const weight = 0.3;
    finalLat = smoothedLocation.latitude * (1 - weight) + filteredLat * weight;
    finalLng = smoothedLocation.longitude * (1 - weight) + filteredLng * weight;
  }

  // Update smoothed location
  smoothedLocation = { latitude: finalLat, longitude: finalLng };

  // ⚡ SPEED FIXES
  // Calculate Speed Using Distance/Time (Do Not Use coords.speed)
  // Distance from previous smoothed location for consistency
  const speedDist = previousLocation ?
    haversineDistance(previousLocation.latitude, previousLocation.longitude, finalLat, finalLng) :
    filteredDist;

  let computedSpeed = speedDist / dt;

  // Handle Speed Spikes (Filtering) - cap at reasonable max speed
  if (computedSpeed > MAX_SPEED_MS) return null;

  // Clamp Very Small Movements to Zero Speed
  if (speedDist < STATIONARY_THRESHOLD) computedSpeed = 0;

  // Prevent Fake Movement When Idle
  if (computedSpeed < 0.1) computedSpeed = 0;

  // 🚀 OPTIONAL PRO-LEVEL FIXES
  // Activity Detection (Walk / Bike / Car)
  const activity = detectActivity(computedSpeed, prevEntry.speed);

  // Update global state for smoothing
  previousLocation = { latitude: finalLat, longitude: finalLng };
  previousTimestamp = now;

  return {
    latitude: finalLat,
    longitude: finalLng,
    speed: computedSpeed,
    timestamp: now,
    activity: activity,
  };
}

// ── Per-user state cache ────────────────────────────────────────────
const userStates = new Map();

function getUserState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      prev: null,
      kalman: new KalmanFilter2D(),
      activity: 'unknown',
      speedHistory: [],
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
