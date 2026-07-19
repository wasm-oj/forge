import * as std from "std";

const input: string = std.in.readAsString();
let cursor = 0;
function nextToken(): string {
    while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
    const start = cursor;
    while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
    return input.slice(start, cursor);
}
function verdictIndex(value: string): number {
    if (value === "A") return 0;
    if (value === "W") return 1;
    if (value === "R") return 2;
    return 3;
}

const n = Number(nextToken());
const q = Number(nextToken());
const verdicts = nextToken();
const prefix: Uint32Array[] = Array.from({ length: 4 }, () => new Uint32Array(n + 1));
for (let index = 1; index <= n; index++) {
    for (let kind = 0; kind < 4; kind++) prefix[kind][index] = prefix[kind][index - 1];
    prefix[verdictIndex(verdicts[index - 1])][index]++;
}
let output = "";
function emit(line: number): void {
    output += `${line}\n`;
    if (output.length >= 65536) {
        std.out.puts(output);
        output = "";
    }
}
for (let query = 0; query < q; query++) {
    const left = Number(nextToken());
    const right = Number(nextToken());
    const kind = verdictIndex(nextToken());
    emit(prefix[kind][right] - prefix[kind][left - 1]);
}
if (output) std.out.puts(output);
