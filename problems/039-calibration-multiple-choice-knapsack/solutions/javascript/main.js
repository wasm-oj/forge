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

const groupCount = nextInt(), capacity = nextInt();
let dp = new BigUint64Array(capacity + 1),
  next = new BigUint64Array(capacity + 1);
for (let group = 0; group < groupCount; group++) {
  const optionCount = nextInt(),
    times = new Int32Array(optionCount),
    values = new BigUint64Array(optionCount);
  for (let option = 0; option < optionCount; option++) {
    times[option] = nextInt();
    values[option] = nextBigInt();
  }
  next.set(dp);
  for (let option = 0; option < optionCount; option++) {
    const time = times[option], value = values[option];
    for (let current = time; current <= capacity; current++) {
      const candidate = dp[current - time] + value;
      if (candidate > next[current]) next[current] = candidate;
    }
  }
  [dp, next] = [next, dp];
}
std.out.puts(`${dp[capacity]}\n`);
