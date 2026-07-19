#!/usr/bin/env python3
import re, sys

tok = re.compile(r"[a-z0-9]{1,20}")
path = re.compile(r"[a-z0-9]+(?:\.[a-z0-9]+)*")


def difference_count(baseline, current):
    total = 0
    for (_, left), (_, right) in zip(baseline, current):
        i = j = 0
        while i < len(left) or j < len(right):
            if j == len(right) or (i < len(left) and left[i][0] < right[j][0]):
                total += 1
                i += 1
            elif i == len(left) or right[j][0] < left[i][0]:
                total += 1
                j += 1
            else:
                total += left[i][1] != right[j][1]
                i += 1
                j += 1
        if total > 200000:
            return total
    return total


try:
    l = sys.stdin.read().splitlines()
    at = 0
    H = int(l[at])
    at += 1
    assert 2 <= H <= 200
    names = set()
    tc = tf = differences = 0
    baseline = None
    for host_index in range(H):
        h = l[at].split()
        at += 1
        assert len(h) == 2 and tok.fullmatch(h[0])
        name = h[0]
        K = int(h[1])
        assert name not in names and 0 <= K <= 200000
        names.add(name)
        ids = set()
        cases = []
        tc += K
        assert tc <= 200000
        for _ in range(K):
            p = l[at].split()
            at += 1
            assert len(p) == 3 and tok.fullmatch(p[0]) and p[0] not in ids
            ids.add(p[0])
            runtime = int(p[1])
            P = int(p[2])
            assert 0 <= runtime <= 10**18 and 0 <= P <= 200000
            tf += P
            assert tf <= 200000
            prev = None
            fields = []
            for _ in range(P):
                x = l[at].split()
                at += 1
                assert (
                    len(x) == 2
                    and len(x[0]) <= 120
                    and path.fullmatch(x[0])
                    and tok.fullmatch(x[1])
                    and (prev is None or prev < x[0])
                )
                prev = x[0]
                fields.append((x[0], x[1]))
            cases.append((p[0], fields))
        if host_index == 0:
            baseline = cases
        elif [case[0] for case in cases] == [case[0] for case in baseline]:
            differences += difference_count(baseline, cases)
            assert differences <= 200000
    assert at == len(l)
except Exception:
    sys.exit(1)
