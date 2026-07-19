#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    size_t n, q;
    if (scanf("%zu %zu", &n, &q) != 2) {
        return 0;
    }

    uint64_t *costs = malloc(n * sizeof(*costs));
    if (costs == NULL) {
        return 1;
    }
    for (size_t i = 0; i < n; ++i) {
        scanf("%" SCNu64, &costs[i]);
    }

    size_t completed = 0;
    uint64_t spent = 0;
    for (size_t query = 0; query < q; ++query) {
        uint64_t budget;
        scanf("%" SCNu64, &budget);
        while (completed < n && costs[completed] <= budget - spent) {
            spent += costs[completed];
            ++completed;
        }
        printf("%zu\n", completed);
    }

    free(costs);
    return 0;
}
