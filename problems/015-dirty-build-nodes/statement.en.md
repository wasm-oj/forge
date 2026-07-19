# A Header Changed: What Must Be Rebuilt?

The build graph is a DAG. An edge `u v` means that node `v`'s artifact directly depends on node `u`. When a node changes, that node and every node that depends on it directly or indirectly become dirty. Given all nodes changed in one batch, output every dirty node.

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
