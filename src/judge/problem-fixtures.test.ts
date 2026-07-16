import { describe, expect, it } from "vitest";
import { PROBLEMS } from "./problems";

type FixtureSolver = (values: bigint[]) => string;

const MOD = 1_000_000_007n;

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

function fibonacciPair(index: bigint): [bigint, bigint] {
  if (index === 0n) return [0n, 1n];
  const [left, right] = fibonacciPair(index >> 1n);
  const doubled = left * ((2n * right - left + MOD) % MOD) % MOD;
  const adjacent = (left * left + right * right) % MOD;
  return index & 1n ? [adjacent, (doubled + adjacent) % MOD] : [doubled, adjacent];
}

const SOLVERS: Record<string, FixtureSolver> = {
  "sum-pair": ([a, b]) => String(a + b),
  "temperature-span": (values) => String(values.reduce((a, b) => a > b ? a : b) - values.reduce((a, b) => a < b ? a : b)),
  "seconds-clock": ([seconds]) => `${seconds / 3600n} ${seconds / 60n % 60n} ${seconds % 60n}`,
  "leap-year": ([year]) => year % 400n === 0n || (year % 4n === 0n && year % 100n !== 0n) ? "YES" : "NO",
  "range-sum": ([n]) => String(n * (n + 1n) / 2n),
  "factorial-zeros": ([n]) => {
    let count = 0n;
    while (n > 0n) {
      n /= 5n;
      count += n;
    }
    return String(count);
  },
  "greatest-common-divisor": ([a, b]) => String(gcd(a, b)),
  "least-common-multiple": ([a, b]) => String(a / gcd(a, b) * b),
  "prime-gate": ([n]) => {
    if (n < 2n) return "NO";
    for (let divisor = 2n; divisor * divisor <= n; divisor += divisor === 2n ? 1n : 2n) {
      if (n % divisor === 0n) return "NO";
    }
    return "YES";
  },
  "reverse-number": ([n]) => {
    let reversed = 0n;
    do {
      reversed = reversed * 10n + n % 10n;
      n /= 10n;
    } while (n > 0n);
    return String(reversed);
  },
  "digit-sum": ([n]) => {
    let sum = 0n;
    while (n > 0n) {
      sum += n % 10n;
      n /= 10n;
    }
    return String(sum);
  },
  "collatz-steps": ([n]) => {
    let steps = 0n;
    while (n !== 1n) {
      n = n % 2n === 0n ? n / 2n : 3n * n + 1n;
      steps += 1n;
    }
    return String(steps);
  },
  "fibonacci-mod": ([n]) => String(fibonacciPair(n)[0]),
  "modular-power": ([base, exponent, modulus]) => {
    let result = 1n % modulus;
    base %= modulus;
    while (exponent > 0n) {
      if (exponent & 1n) result = result * base % modulus;
      base = base * base % modulus;
      exponent >>= 1n;
    }
    return String(result);
  },
  "stream-maximum": ([count, ...values]) => {
    const items = values.slice(0, Number(count));
    let maximum = items[0];
    let position = 1;
    items.forEach((value, index) => {
      if (value > maximum) {
        maximum = value;
        position = index + 1;
      }
    });
    return `${maximum} ${position}`;
  },
  "energy-ledger": ([count, ...values]) => {
    let energy = 0n;
    let minimum = 0n;
    for (const change of values.slice(0, Number(count))) {
      energy += change;
      if (energy < minimum) minimum = energy;
    }
    return `${energy} ${minimum}`;
  },
  "increasing-run": ([count, ...values]) => {
    const items = values.slice(0, Number(count));
    let best = 1;
    let current = 1;
    for (let index = 1; index < items.length; index += 1) {
      current = items[index] > items[index - 1] ? current + 1 : 1;
      if (current > best) best = current;
    }
    return String(best);
  },
  "single-trade": ([count, ...values]) => {
    const items = values.slice(0, Number(count));
    let minimum = items[0];
    let profit = 0n;
    for (const price of items) {
      if (price < minimum) minimum = price;
      if (price - minimum > profit) profit = price - minimum;
    }
    return String(profit);
  },
  "majority-signal": ([count, ...values]) => {
    let candidate = 0n;
    let votes = 0;
    for (const value of values.slice(0, Number(count))) {
      if (votes === 0) candidate = value;
      votes += value === candidate ? 1 : -1;
    }
    return String(candidate);
  },
  "maximum-subarray": ([count, ...values]) => {
    const items = values.slice(0, Number(count));
    let current = items[0];
    let best = items[0];
    for (const value of items.slice(1)) {
      current = value > current + value ? value : current + value;
      if (current > best) best = current;
    }
    return String(best);
  },
};

describe("problem fixture answers", () => {
  it("matches the reference solution for every local judge case", () => {
    expect(Object.keys(SOLVERS).sort()).toEqual(PROBLEMS.map((problem) => problem.id).sort());
    for (const problem of PROBLEMS) {
      for (const test of problem.judgeCases) {
        const values = test.input.trim().split(/\s+/).filter(Boolean).map(BigInt);
        expect(SOLVERS[problem.id](values), `${problem.id}: ${test.input}`).toBe(test.output.trim());
      }
    }
  });
});
