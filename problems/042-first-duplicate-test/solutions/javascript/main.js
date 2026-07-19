import * as std from "std";

const input = std.in.readAsString();
let cursor = 0;
function nextToken() {
  while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
  const start = cursor;
  while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
  return input.slice(start, cursor);
}

const count = Number(nextToken());
const firstIndex = new Map();
let answer = "NONE";
for (let index = 1; index <= count; index++) {
  const fingerprint = nextToken();
  const earliest = firstIndex.get(fingerprint);
  if (earliest !== undefined) {
    answer = `${index} ${earliest}`;
    break;
  }
  firstIndex.set(fingerprint, index);
}
std.out.puts(`${answer}\n`);
