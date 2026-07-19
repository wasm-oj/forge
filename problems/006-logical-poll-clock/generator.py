import random
import sys


if len(sys.argv) != 3:
    raise SystemExit("usage: generator.py SEED INDEX")

seed = int(sys.argv[1])
index = int(sys.argv[2])
rng = random.Random((seed << 32) ^ index)
target = rng.randint(2, 8 + index % 12)
commands = []
active = {}
next_id = 1
clock = 0


def add_timer(timer_id, deadline):
    active[timer_id] = deadline
    commands.append(f"T {timer_id} {deadline}")


def poll(ready):
    global clock
    commands.append(f"P {ready}")
    if ready == 0 and active:
        clock = max(clock, min(active.values()))
    fired = [timer_id for timer_id, deadline in active.items() if deadline <= clock]
    for timer_id in fired:
        del active[timer_id]


# Every fourth index explicitly covers a timer that survives a poll and is
# canceled afterward. The remaining suffix still varies by seed.
if index % 4 == 0:
    target = max(target, 5)
    add_timer(1, 5)
    add_timer(2, 10)
    next_id = 3
    poll(0)
    del active[2]
    commands.append("C 2")

while len(commands) < target - 1:
    choices = ["P", "T"]
    if active:
        choices.append("C")
    operation = rng.choice(choices)
    if operation == "T":
        add_timer(next_id, rng.randint(0, 30))
        next_id += 1
    elif operation == "C":
        timer_id = rng.choice(list(active))
        del active[timer_id]
        commands.append(f"C {timer_id}")
    else:
        poll(rng.randint(0, 3))

poll(rng.randint(0, 2))
print(len(commands))
print("\n".join(commands))
