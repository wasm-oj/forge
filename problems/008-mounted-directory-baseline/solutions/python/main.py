import sys


tokens = iter(map(int, sys.stdin.buffer.read().split()))
mounted_count = next(tokens)
output_count = next(tokens)
byte_quota = next(tokens)
inode_quota = next(tokens)

path_count = mounted_count + output_count
paths: list[tuple[int, ...]] = []
baseline_bytes = 0
for index in range(path_count):
    length = next(tokens)
    paths.append(tuple(next(tokens) for _ in range(length)))
    if index < mounted_count:
        baseline_bytes += next(tokens)

paths.sort()
directory_count = 1
for index, path in enumerate(paths):
    parent_length = len(path) - 1
    already_present = 0
    if index > 0:
        previous = paths[index - 1]
        limit = min(len(previous), len(path))
        while (
            already_present < limit
            and previous[already_present] == path[already_present]
        ):
            already_present += 1
        already_present = min(already_present, parent_length)
    directory_count += parent_length - already_present

baseline_inodes = directory_count + path_count
accepted = baseline_bytes <= byte_quota and baseline_inodes <= inode_quota
if accepted:
    print(
        "ACCEPT",
        baseline_bytes,
        baseline_inodes,
        byte_quota - baseline_bytes,
        inode_quota - baseline_inodes,
    )
else:
    print(
        "REJECT",
        baseline_bytes,
        baseline_inodes,
        max(0, baseline_bytes - byte_quota),
        max(0, baseline_inodes - inode_quota),
    )
