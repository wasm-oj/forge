package main

import (
	"bufio"
	"fmt"
	"os"
)

const mod int64 = 1_000_000_007

func main() {
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer out.Flush()
	var n, m int
	fmt.Fscan(in, &n, &m)
	duration := make([]int64, n)
	for i := range duration {
		fmt.Fscan(in, &duration[i])
	}
	graph := make([][]int, n)
	indegree := make([]int, n)
	outdegree := make([]int, n)
	for i := 0; i < m; i++ {
		var u, v int
		fmt.Fscan(in, &u, &v)
		u--
		v--
		graph[u] = append(graph[u], v)
		indegree[v]++
		outdegree[u]++
	}
	best := make([]int64, n)
	ways := make([]int64, n)
	queue := make([]int, 0, n)
	for node := 0; node < n; node++ {
		if indegree[node] == 0 {
			best[node] = duration[node]
			ways[node] = 1
			queue = append(queue, node)
		}
	}
	for head := 0; head < len(queue); head++ {
		node := queue[head]
		for _, target := range graph[node] {
			candidate := best[node] + duration[target]
			if candidate > best[target] {
				best[target] = candidate
				ways[target] = ways[node]
			} else if candidate == best[target] {
				ways[target] = (ways[target] + ways[node]) % mod
			}
			indegree[target]--
			if indegree[target] == 0 {
				queue = append(queue, target)
			}
		}
	}
	var answer int64 = -1
	var count int64
	for node := 0; node < n; node++ {
		if outdegree[node] != 0 {
			continue
		}
		if best[node] > answer {
			answer = best[node]
			count = ways[node]
		} else if best[node] == answer {
			count = (count + ways[node]) % mod
		}
	}
	fmt.Fprintln(out, answer, count)
}
