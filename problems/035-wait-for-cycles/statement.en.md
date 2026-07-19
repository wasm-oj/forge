# Wait-For Cycles

While designing the interactive-program runtime for a WASM OJ, we needed to handle processes that wait for events from one another. Releasing one process may let it wake other processes, but a group whose first event can only come from within the same group may otherwise remain stalled forever.

To diagnose this situation, we want both to list the groups that contain an actual wait cycle and to determine the minimum number of external wake events needed for release events to reach the entire system.

There are `N` processes that have not yet been released. A directed release edge `u v` means that once `u` is released, it can send an event that releases `v`. Release events continue propagating along edges. You may also inject external wake events, each into any process.

Two processes belong to the same mutually waiting group if each is reachable from the other. A strongly connected component containing a directed cycle is a **wait-cycle group**: every SCC of size greater than `1` qualifies, while a singleton qualifies only if it has a self-loop.

List every wait-cycle group and compute the minimum number of external wake events required to release all processes. One wake may target any process. Release propagates throughout its SCC and then downstream along condensation edges.

## Input

The first line contains `N M`. Each of the next `M` lines contains a directed edge `u v`. Process IDs are 1-based.

## Output

The first line contains `G W`: the number of wait-cycle groups and the minimum number of external wake events. Then output `G` lines, each in the form:

```text
k id_1 ... id_k
```

IDs within a group must be strictly increasing. Groups must be strictly increasing by their smallest ID. If `G = 0`, output only the first line. An isolated process is a non-cyclic singleton SCC, but it is also a source of the condensation graph and therefore still requires one wake.

## Constraints

- `1 <= N <= 200000`
- `0 <= M <= 400000`
- Edges are distinct; self-loops are allowed.
- Full tests contain long chains on which recursive DFS may overflow the call stack; use an explicit stack.
- Pairwise mutual-reachability checks cannot pass.

## Examples

<!-- BEGIN GENERATED SAMPLES -->

### Example One

Input:

```text
5 4
1 2
2 1
2 3
4 4
```

Output:

```text
2 3
2 1 2
1 4
```

### Example Two

Input:

```text
3 2
1 2
2 3
```

Output:

```text
0 1
```

### Example Three

Input:

```text
3 3
1 2
2 3
3 1
```

Output:

```text
1 1
3 1 2 3
```

<!-- END GENERATED SAMPLES -->
