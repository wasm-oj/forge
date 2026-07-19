import * as std from "std";

/** @typedef {{ cost: number, index: number }} CaseRecord */

const input = std.in.readAsString();
let cursor = 0;
function nextToken() {
    while (cursor < input.length && input.charCodeAt(cursor) <= 32) cursor++;
    const start = cursor;
    while (cursor < input.length && input.charCodeAt(cursor) > 32) cursor++;
    return input.slice(start, cursor);
}

/** @param {CaseRecord} left @param {CaseRecord} right */
function better(left, right) {
    return left.cost > right.cost || (left.cost === right.cost && left.index < right.index);
}

/** @param {CaseRecord} left @param {CaseRecord} right */
function worse(left, right) {
    return left.cost < right.cost || (left.cost === right.cost && left.index > right.index);
}

/** @param {CaseRecord[]} heap @param {CaseRecord} value */
function push(heap, value) {
    let position = heap.length;
    heap.push(value);
    while (position > 0) {
        const parent = Math.floor((position - 1) / 2);
        if (!worse(heap[position], heap[parent])) break;
        [heap[position], heap[parent]] = [heap[parent], heap[position]];
        position = parent;
    }
}

/** @param {CaseRecord[]} heap */
function repairRoot(heap) {
    let position = 0;
    while (true) {
        const left = position * 2 + 1;
        if (left >= heap.length) return;
        const right = left + 1;
        let child = left;
        if (right < heap.length && worse(heap[right], heap[left])) child = right;
        if (!worse(heap[child], heap[position])) return;
        [heap[child], heap[position]] = [heap[position], heap[child]];
        position = child;
    }
}

const n = Number(nextToken());
const k = Number(nextToken());
/** @type {CaseRecord[]} */
const heap = [];
let output = "";
/** @param {CaseRecord} item */
function emit(item) {
    output += `${item.index} ${item.cost}\n`;
    if (output.length >= 65536) {
        std.out.puts(output);
        output = "";
    }
}
for (let index = 1; index <= n; index++) {
    const candidate = { cost: Number(nextToken()), index };
    if (heap.length < k) {
        push(heap, candidate);
    } else if (better(candidate, heap[0])) {
        heap[0] = candidate;
        repairRoot(heap);
    }
    if (index >= k) emit(heap[0]);
}
if (output) std.out.puts(output);
