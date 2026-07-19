import * as std from "std";

const input = std.in.readAsString();
let scan = 0;
function nextInt() {
  while (scan < input.length && input.charCodeAt(scan) <= 32) scan++;
  let value = 0;
  while (scan < input.length) {
    const digit = input.charCodeAt(scan) - 48;
    if (digit < 0 || digit > 9) break;
    value = value * 10 + digit;
    scan++;
  }
  return value;
}
/** @param {number} value @returns {number} */
function popcount(value) {
  let count = 0;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}

const featureCount = nextInt(),
  testCount = nextInt(),
  budget = nextInt(),
  states = 1 << featureCount;
let dp = new Float64Array(states), next = new Float64Array(states);
dp.fill(Number.POSITIVE_INFINITY);
dp[0] = 0;
for (let test = 0; test < testCount; test++) {
  const cost = nextInt(), coveredCount = nextInt();
  let covered = 0;
  for (let i = 0; i < coveredCount; i++) covered |= 1 << (nextInt() - 1);
  next.set(dp);
  for (let mask = 0; mask < states; mask++) {
    if (dp[mask] !== Number.POSITIVE_INFINITY) {
      const union = mask | covered, candidate = dp[mask] + cost;
      if (candidate < next[union]) next[union] = candidate;
    }
  }
  [dp, next] = [next, dp];
}
let answer = 0;
for (let mask = 0; mask < states; mask++) {
  if (dp[mask] <= budget) answer = Math.max(answer, popcount(mask));
}
std.out.puts(`${answer}\n`);
