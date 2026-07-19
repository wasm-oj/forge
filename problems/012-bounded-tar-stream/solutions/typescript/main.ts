import * as std from "std";
const input: string = std.in.readAsString();
let p: number = 0;
const nextToken = (): string => {
  while (p < input.length && input.charCodeAt(p) <= 32) p++;
  const start = p;
  while (p < input.length && input.charCodeAt(p) > 32) p++;
  return input.slice(start, p);
};
const n: number = Number(nextToken()),
  ln: bigint = BigInt(nextToken()),
  lb: bigint = BigInt(nextToken());
let off = 0n, cnt = 0n, used = 0n, pending: string | null = null, done = false;
const ok = (s: string): boolean =>
  !s.startsWith("/") && !s.endsWith("/") &&
  s.split("/").every((x) =>
    x !== "" && x !== "." && x !== ".." && /^[a-z0-9._-]+$/.test(x)
  );
for (let i = 1; i <= n; i++) {
  const got = BigInt(nextToken()),
    t = nextToken(),
    name = nextToken(),
    z = BigInt(nextToken()),
    x = BigInt(nextToken()),
    y = BigInt(nextToken());
  const meta = t === "G" || t === "P",
    actual = t === "F" || t === "D",
    eff = pending ?? name;
  let e: string | null = null;
  if (got !== off) e = "OFFSET";
  else if (x !== y) e = "CHECKSUM";
  else if (!"FDGP".includes(t)) e = "TYPE";
  else if (meta && pending !== null) e = "STATE";
  else if (meta && z !== BigInt(name.length + 1)) e = "META_SIZE";
  else if (meta && !ok(name)) e = "PATH";
  else if (actual && !ok(eff)) e = "PATH";
  else if (t === "D" && z !== 0n) e = "ENTRY_SIZE";
  else if (t === "F" && (cnt === ln || z > lb - used)) e = "LIMIT";
  if (e !== null) {
    std.out.puts(`REJECT ${i} ${e}\n`);
    done = true;
    break;
  }
  off += 512n + ((z + 511n) / 512n) * 512n;
  if (meta) pending = name;
  else {
    pending = null;
    if (t === "F") {
      cnt++;
      used += z;
    }
  }
}
if (!done) {
  std.out.puts(
    pending !== null
      ? `REJECT ${n + 1} STATE\n`
      : `ACCEPT ${cnt} ${used} ${off}\n`,
  );
}
