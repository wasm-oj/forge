import * as std from "std";

const tokens: string[] = std.in.readAsString().trim().split(/\s+/);
let position = 0;
const n = Number(tokens[position++]);
const q = Number(tokens[position++]);
const costs: bigint[] = Array.from({ length: n }, () => BigInt(tokens[position++]));

let completed = 0;
let spent = 0n;
const answers: string[] = [];
for (let query = 0; query < q; query++) {
  const budget = BigInt(tokens[position++]);
  while (completed < n && costs[completed] <= budget - spent) {
    spent += costs[completed++];
  }
  answers.push(String(completed));
}

std.out.puts(answers.join("\n") + "\n");
