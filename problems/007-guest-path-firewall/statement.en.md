# Guest Path Firewall

A WASM OJ lets submitted programs access an isolated guest file system, but paths supplied by those programs cannot be passed directly to the host. Repeated separators, `.`, and `..` can make different-looking strings refer to the same place or even attempt to cross the guest root. To obtain a consistent result before any real file access, we first perform purely lexical normalization.

You receive `N` untrusted absolute guest paths. Process the segments of each path from left to right using these POSIX-like rules:

- Ignore empty segments, which arise from repeated `/` or the leading or trailing `/`.
- Ignore a segment equal to `.`.
- A segment equal to `..` removes the preceding ordinary segment that has not already been removed.
- If no ordinary segment can be removed when `..` is encountered, the path has attempted to escape the guest root and is `INVALID`. Once this happens, the path remains invalid even if later segments would return it to the root.
- Every other segment, including `...`, is ordinary. Case is not converted.

For a valid path, output its unique canonical absolute form: use a single `/` between segments, contain neither `.` nor `..` segments, and have no trailing slash. If there are no ordinary segments, output `/`.

The result is determined entirely by the input string; the host file system is neither needed nor consulted.

## Input

The first line contains `N`. Each of the next `N` lines contains one path token. Every path begins with `/` and contains no whitespace.

## Output

For each path, output its canonical form if valid, or `INVALID` otherwise.

## Constraints

- `1 ≤ N ≤ 200000`
- Each path has length from `1` through `200000`.
- The sum `L` of all path lengths is at most `2000000`.
- Paths contain only lowercase ASCII letters, digits, `_`, `-`, `.`, and `/`.
- There is no separate length limit on an ordinary segment.

This is purely lexical processing: do not query the host filesystem, resolve symlinks, or perform percent decoding. The full constraints rule out quadratic algorithms that repeatedly rewrite an entire string.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
6
/a/b
/a/./b//c/
/a/b/../../c
/../secret
/a/.../b
////
```

Output:

```text
/a/b
/a/b/c
/c
INVALID
/a/.../b
/
```

### Example Two

Input:

```text
4
/
/././
/x/../
/x/../../x
```

Output:

```text
/
/
/
INVALID
```

### Example Three

Input:

```text
5
/a//b///c
/a-b/c_d/9
/.../../z
/a/..hidden/..
/a/../..x
```

Output:

```text
/a/b/c
/a-b/c_d/9
/z
/a
/..x
```

<!-- END GENERATED SAMPLES -->
