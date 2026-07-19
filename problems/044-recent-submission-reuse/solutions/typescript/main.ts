import * as std from "std";

const input: string = std.in.readAsString();
let cursor = 0;
function nextToken(): string {
  while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
  const start = cursor;
  while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
  return input.slice(start, cursor);
}

const count = Number(nextToken());
const windowSize = Number(nextToken());
const lastIndex = new Map<string, number>();
let hits = 0;
for (let index = 1; index <= count; index++) {
  const fingerprint = nextToken();
  const previous = lastIndex.get(fingerprint);
  if (previous !== undefined && index - previous <= windowSize) hits++;
  lastIndex.set(fingerprint, index);
}
std.out.puts(`${hits}\n`);
