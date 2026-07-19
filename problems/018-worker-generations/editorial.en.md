# Editorial

## Intuitive Approach

Store every assignment and replay the history before build `i` to recover the active generation, family, and used stages. This is correct but takes `O(N^2)` total time.

## Optimal Approach: Keep Only the Current Generation

Only four state values are needed: the current generation ID, its family, its used budget, and the rejection count. Handle `stages=0` first, followed by the two rejection conditions; neither branch may alter worker state. For a valid cache miss, if the current worker cannot serve it, increment the generation ID, replace the family, and reset used budget to zero. Then add `stages`.

This is also the forced greedy choice: when the active worker is compatible, reusing it does not create a worker; when it is not compatible, creating a new generation is the only legal action.

## Correctness Proof

Induct over the build prefix. Initially no worker exists, so the state is correct. Cache and rejection branches output exactly as defined and preserve state. For a valid miss, if the active worker has the same family and enough capacity, it can and must serve the build; the algorithm does so and increases used budget correctly. Otherwise no legal active worker exists, and the only permitted action is to create the next generation; the algorithm assigns the next consecutive ID and places the build there. Every output and successor state is therefore uniquely correct, as are the final counts.

## Complexity

Each build takes constant work, so time is `O(N)`. Excluding output buffering, additional space is `O(1)`; the current family string has length at most 20.

## Common Mistakes

- Switching the active family on a cache hit.
- Consuming budget or creating a generation for a rejected build.
- Reusing an older worker when the family later changes back.
- Checking `stages>B` in a way that lets `stages=0` modify state in a corner case.
