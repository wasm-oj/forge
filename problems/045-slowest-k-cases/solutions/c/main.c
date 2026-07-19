#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct {
    uint64_t cost;
    int index;
} Case;

static int better(Case left, Case right) {
    return left.cost > right.cost || (left.cost == right.cost && left.index < right.index);
}

static int worse(Case left, Case right) {
    return left.cost < right.cost || (left.cost == right.cost && left.index > right.index);
}

static void swap(Case *left, Case *right) {
    Case temporary = *left;
    *left = *right;
    *right = temporary;
}

static void push(Case *heap, int *size, Case value) {
    int position = (*size)++;
    heap[position] = value;
    while (position > 0) {
        int parent = (position - 1) / 2;
        if (!worse(heap[position], heap[parent])) break;
        swap(&heap[position], &heap[parent]);
        position = parent;
    }
}

static void repair_root(Case *heap, int size) {
    int position = 0;
    for (;;) {
        int left = position * 2 + 1;
        if (left >= size) break;
        int child = left;
        int right = left + 1;
        if (right < size && worse(heap[right], heap[left])) child = right;
        if (!worse(heap[child], heap[position])) break;
        swap(&heap[child], &heap[position]);
        position = child;
    }
}

int main(void) {
    int n, k;
    if (scanf("%d%d", &n, &k) != 2) return 1;
    Case *heap = malloc((size_t)k * sizeof(*heap));
    if (heap == NULL) return 1;
    int size = 0;
    for (int index = 1; index <= n; index++) {
        uint64_t cost;
        if (scanf("%" SCNu64, &cost) != 1) return 1;
        Case candidate = {cost, index};
        if (size < k) {
            push(heap, &size, candidate);
        } else if (better(candidate, heap[0])) {
            heap[0] = candidate;
            repair_root(heap, size);
        }
        if (index >= k) printf("%d %" PRIu64 "\n", heap[0].index, heap[0].cost);
    }
    free(heap);
    return 0;
}
