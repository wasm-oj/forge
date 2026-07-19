#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int verdict_index(char value) {
    if (value == 'A') return 0;
    if (value == 'W') return 1;
    if (value == 'R') return 2;
    return 3;
}

int main(void) {
    int n, q;
    if (scanf("%d%d", &n, &q) != 2) return 1;
    char *verdicts = malloc((size_t)n + 1U);
    uint32_t *prefix = calloc((size_t)4 * ((size_t)n + 1U), sizeof(*prefix));
    if (verdicts == NULL || prefix == NULL) return 1;
    if (scanf("%s", verdicts) != 1) return 1;
    size_t stride = (size_t)n + 1U;
    for (int i = 1; i <= n; i++) {
        for (int kind = 0; kind < 4; kind++) {
            prefix[(size_t)kind * stride + (size_t)i] = prefix[(size_t)kind * stride + (size_t)(i - 1)];
        }
        int kind = verdict_index(verdicts[i - 1]);
        prefix[(size_t)kind * stride + (size_t)i]++;
    }
    for (int query = 0; query < q; query++) {
        int left, right;
        char verdict[2];
        if (scanf("%d%d%1s", &left, &right, verdict) != 3) return 1;
        int kind = verdict_index(verdict[0]);
        uint32_t answer = prefix[(size_t)kind * stride + (size_t)right]
            - prefix[(size_t)kind * stride + (size_t)(left - 1)];
        printf("%u\n", answer);
    }
    free(prefix);
    free(verdicts);
    return 0;
}
