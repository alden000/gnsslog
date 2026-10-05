// Position quality, shared by the app and the Analyzer: stretches where the phone had no proper
// GNSS (car parks, tunnels, indoors) are drawn faint and dashed rather than as real movement.

export const POOR_ACC = 25; // m: the phone's own accuracy figure (Wi-Fi / dead reckoning above this)
export const POOR_SIGMA = 12; // m: the position filter's uncertainty (coasting without fixes)

export function isPoor(acc, posSigma) {
  return acc > POOR_ACC || posSigma > POOR_SIGMA;
}
