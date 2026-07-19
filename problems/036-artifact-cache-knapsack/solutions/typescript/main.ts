import * as std from "std";

const input: string = std.in.readAsString();
let scan = 0;
function nextInt(): number {
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
function nextBigInt(): bigint {
  while (scan < input.length && input.charCodeAt(scan) <= 32) scan++;
  const start = scan;
  while (scan < input.length) {
    const code = input.charCodeAt(scan);
    if (code < 48 || code > 57) break;
    scan++;
  }
  return BigInt(input.slice(start, scan));
}

const itemCount = nextInt(),
  capacity = nextInt(),
  dp = new BigUint64Array(capacity + 1);
for (let item = 0; item < itemCount; item++) {
  const size = nextInt(), value = nextBigInt();
  for (let current = capacity; current >= size; current--) {
    const candidate = dp[current - size]! + value;
    if (candidate > dp[current]!) dp[current] = candidate;
  }
}
std.out.puts(`${dp[capacity]}\n`);
