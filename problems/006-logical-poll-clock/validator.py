import heapq, re, sys


def fail():
    raise SystemExit(1)


try:
    t = sys.stdin.buffer.read().decode("utf-8").split()
    p = 0

    def u(a, b):
        global p
        if p >= len(t) or re.fullmatch(r"0|[1-9][0-9]*", t[p]) is None:
            fail()
        v = int(t[p])
        p += 1
        if not a <= v <= b:
            fail()
        return v

    N = u(1, 200000)
    seen = set()
    active = set()
    h = []
    clock = 0
    polls = 0
    for _ in range(N):
        if p >= len(t):
            fail()
        op = t[p]
        p += 1
        if op == "T":
            x = u(1, N)
            deadline = u(0, 9 * 10**18)
            if x in seen:
                fail()
            seen.add(x)
            active.add(x)
            heapq.heappush(h, (deadline, x))
        elif op == "C":
            x = u(1, N)
            if x not in active:
                fail()
            active.remove(x)
        elif op == "P":
            ready = u(0, 10**9)
            polls += 1
            while h and h[0][1] not in active:
                heapq.heappop(h)
            if ready == 0 and h:
                clock = max(clock, h[0][0])
            while h and h[0][0] <= clock:
                _, x = heapq.heappop(h)
                active.discard(x)
        else:
            fail()
    if polls == 0 or p != len(t):
        fail()
except (UnicodeDecodeError, ValueError, OverflowError):
    fail()
