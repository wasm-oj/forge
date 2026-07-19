# A Header Changed: What Must Be Rebuilt?

A WASM OJ build cache avoids rebuilding every intermediate artifact for each submission, but only if it never reuses a stale result. When a shared header, generated file, or other build node changes, every artifact that depends on it must be invalidated. Nodes unrelated to the change should remain available in the cache.

We represent these relationships as a build graph. The graph is a DAG, and an edge `u v` means that node `v`'s artifact directly depends on node `u`. When a node changes, that node becomes dirty, as does every node that depends on it directly or indirectly.

One file update may change several nodes at once. Given every node changed in the same batch, output all nodes that must be considered dirty.

## Input

The first line contains `N M C`. The next `M` lines each contain `u v`. The final line contains `C` distinct changed-node IDs; when `C=0`, the final line is empty. Node IDs are 1-based. Edges already point from dependencies to their users and must not be reversed.

## Output

On the first line, output the number `K` of dirty nodes. On the second line, output every dirty ID in strictly increasing order, separated by single spaces. When `K=0`, the second line must still exist and be empty.

## Constraints

- `1 ≤ N ≤ 200000`
- `0 ≤ M ≤ 400000`
- `0 ≤ C ≤ N`
- The input graph is a DAG with no self-loops or duplicate edges.
- Changed IDs are distinct.

The full constraints rule out running a complete DFS or BFS separately for every changed node.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
6 5 2
1 3
2 4
3 5
4 5
5 6
1 2
```

Output:

```text
6
1 2 3 4 5 6
```

### Example Two

Input:

```text
4 2 1
1 2
1 3
4
```

Output:

```text
1
4
```

### Example Three

Input:

```text
3 2 0
1 2
2 3

```

Output:

```text
0

```

<!-- END GENERATED SAMPLES -->
