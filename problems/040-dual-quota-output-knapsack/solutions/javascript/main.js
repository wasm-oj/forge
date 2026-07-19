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
function nextBigInt() {
  while (scan < input.length && input.charCodeAt(scan) <= 32) scan++;
  const start = scan;
  while (scan < input.length) {
    const code = input.charCodeAt(scan);
    if (code < 48 || code > 57) break;
    scan++;
  }
  return BigInt(input.slice(start, scan));
}

const bundleCount = nextInt(),
  byteLimit = nextInt(),
  entryLimit = nextInt(),
  width = byteLimit + 1,
  dp = new BigUint64Array((entryLimit + 1) * width);
for (let bundle = 0; bundle < bundleCount; bundle++) {
  const bytes = nextInt(), entries = nextInt(), value = nextBigInt();
  for (
    let currentEntries = entryLimit;
    currentEntries >= entries;
    currentEntries--
  ) {
    const row = currentEntries * width,
      previous = (currentEntries - entries) * width;
    for (let currentBytes = byteLimit; currentBytes >= bytes; currentBytes--) {
      const index = row + currentBytes,
        candidate = dp[previous + currentBytes - bytes] + value;
      if (candidate > dp[index]) dp[index] = candidate;
    }
  }
}
std.out.puts(`${dp[entryLimit * width + byteLimit]}\n`);
