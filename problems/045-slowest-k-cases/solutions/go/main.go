package main

import (
	"bufio"
	"container/heap"
	"fmt"
	"os"
)

type Case struct {
	cost  uint64
	index int
}

func better(left, right Case) bool {
	return left.cost > right.cost || left.cost == right.cost && left.index < right.index
}

type CaseHeap []Case

func (values CaseHeap) Len() int { return len(values) }
func (values CaseHeap) Less(i, j int) bool {
	return !better(values[i], values[j]) && (values[i].cost != values[j].cost || values[i].index != values[j].index)
}
func (values CaseHeap) Swap(i, j int) { values[i], values[j] = values[j], values[i] }
func (values *CaseHeap) Push(value any) { *values = append(*values, value.(Case)) }
func (values *CaseHeap) Pop() any {
	old := *values
	value := old[len(old)-1]
	*values = old[:len(old)-1]
	return value
}

func main() {
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer out.Flush()
	var n, k int
	if _, err := fmt.Fscan(in, &n, &k); err != nil {
		return
	}
	values := make(CaseHeap, 0, k)
	heap.Init(&values)
	for index := 1; index <= n; index++ {
		var cost uint64
		fmt.Fscan(in, &cost)
		candidate := Case{cost: cost, index: index}
		if values.Len() < k {
			heap.Push(&values, candidate)
		} else if better(candidate, values[0]) {
			heap.Pop(&values)
			heap.Push(&values, candidate)
		}
		if index >= k {
			fmt.Fprintln(out, values[0].index, values[0].cost)
		}
	}
}
