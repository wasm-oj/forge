import * as std from "std";
const input: string = std.in.readAsString();
let cursor = 0;
function nextToken(): string {
  while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
  const start = cursor;
  while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
  return input.slice(start, cursor);
}
let output = "";
function emit(line: string): void {
  if (line.length >= 65536) {
    if (output.length) std.out.puts(output);
    std.out.puts(line);
    output = "";
    return;
  }
  if (output.length + line.length > 65536) {
    std.out.puts(output);
    output = "";
  }
  output += line;
}
const N = Number(nextToken());
for (let i = 0; i < N; i++) {
  const st: string[] = [];
  let bad = false;
  for (const x of nextToken().split("/")) {
    if (x === "" || x === ".") continue;
    if (x === "..") {
      if (!st.length) {
        bad = true;
        break;
      }
      st.pop();
    } else st.push(x);
  }
  emit((bad ? "INVALID" : "/" + st.join("/")) + "\n");
}
if (output.length) std.out.puts(output);
