# Editorial

## Intuitive Approach

Repeatedly search the string for `//`, `/./`, and `name/..`, rebuilding it after each match. Every rewrite can move `Θ(L)` characters, and inputs such as `/a/a/.../../..` can trigger linearly many rewrites, for `O(L^2)` worst-case time.

## Optimal Approach: Segment Stack

Split on `/` while maintaining a stack of ordinary segments. Do nothing for an empty segment or `.`; push an ordinary segment; for `..`, pop if possible and otherwise immediately mark the path invalid. Finally join the stack with `/`; an empty stack represents the root.

An implementation may store the segments themselves or just their starting positions and lengths in the original string. The latter is the same algorithm but avoids copying intermediate substrings.

## Correctness Proof

Induct from left to right over processed segments. After every prefix, the stack, in order, equals the ordinary segments remaining after lexical normalization of that prefix. Empty segments and `.` do not change the path; an ordinary segment is appended, matching a push; and `..` removes the most recent ordinary segment, matching a pop. If the stack is empty, the specification defines this as escaping the root, which the algorithm correctly rejects. After all segments, the stack is exactly the canonical path's segment sequence, and joining it with single slashes yields the unique required output.

## Complexity

Every character is scanned a constant number of times, and every segment is pushed and popped at most once. Total time is `O(L)` and additional space is `O(L)` across all input (or the maximum single-path length when storage is reused). Reading and writing already require `Ω(L)` time.

## Common Mistakes

- Treating `...`, `.config`, or `..hidden` as special segments.
- Silently ignoring `..` at the root; this problem requires `INVALID`.
- Continuing after an escape and allowing later segments to "repair" it.
- Printing the root as an empty string or retaining a trailing slash.
