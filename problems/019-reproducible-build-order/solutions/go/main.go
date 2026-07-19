package main

import (
	"bufio"
	"container/heap"
	"fmt"
	"os"
	"sort"
)

type H struct {
	a []int
	n []string
}

func (h H) Len() int           { return len(h.a) }
func (h H) Less(i, j int) bool { return h.n[h.a[i]] < h.n[h.a[j]] }
func (h H) Swap(i, j int)      { h.a[i], h.a[j] = h.a[j], h.a[i] }
func (h *H) Push(x any)        { h.a = append(h.a, x.(int)) }
func (h *H) Pop() any          { x := h.a[len(h.a)-1]; h.a = h.a[:len(h.a)-1]; return x }
func main() {
	in := bufio.NewReader(os.Stdin)
	var n, m int
	fmt.Fscan(in, &n, &m)
	names := make([]string, n)
	for i := range names {
		fmt.Fscan(in, &names[i])
	}
	nameOrder := make([]int, n)
	for i := range nameOrder {
		nameOrder[i] = i
	}
	sort.Slice(nameOrder, func(i, j int) bool { return names[nameOrder[i]] < names[nameOrder[j]] })
	findID := func(name string) int {
		i := sort.Search(n, func(i int) bool { return names[nameOrder[i]] >= name })
		if i < n && names[nameOrder[i]] == name {
			return nameOrder[i]
		}
		return -1
	}
	g := make([][]int, n)
	deg := make([]int, n)
	bad := 0
	for i := 1; i <= m; i++ {
		var a, b string
		fmt.Fscan(in, &a, &b)
		x, y := findID(a), findID(b)
		if x < 0 || y < 0 {
			if bad == 0 {
				bad = i
			}
		} else {
			g[y] = append(g[y], x)
			deg[x]++
		}
	}
	if bad > 0 {
		fmt.Println("INVALID DANGLING", bad)
		return
	}
	h := &H{n: names}
	heap.Init(h)
	for i := range names {
		if deg[i] == 0 {
			heap.Push(h, i)
		}
	}
	out := []string{}
	for h.Len() > 0 {
		u := heap.Pop(h).(int)
		out = append(out, names[u])
		for _, v := range g[u] {
			deg[v]--
			if deg[v] == 0 {
				heap.Push(h, v)
			}
		}
	}
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	if len(out) < n {
		fmt.Fprintln(w, "INVALID CYCLE")
	} else {
		fmt.Fprint(w, "ORDER")
		for _, x := range out {
			fmt.Fprint(w, " ", x)
		}
		fmt.Fprintln(w)
	}
}
