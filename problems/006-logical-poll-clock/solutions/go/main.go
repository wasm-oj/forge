package main

import (
	"bufio"
	"container/heap"
	"fmt"
	"os"
)

type item struct {
	d  uint64
	id int
}
type pq []item

func (h pq) Len() int           { return len(h) }
func (h pq) Less(i, j int) bool { return h[i].d < h[j].d || (h[i].d == h[j].d && h[i].id < h[j].id) }
func (h pq) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *pq) Push(x any)        { *h = append(*h, x.(item)) }
func (h *pq) Pop() any          { o := *h; x := o[len(o)-1]; *h = o[:len(o)-1]; return x }
func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n int
	if _, e := fmt.Fscan(in, &n); e != nil {
		return
	}
	h := &pq{}
	heap.Init(h)
	active := make([]bool, n+1)
	var clock uint64
	for z := 0; z < n; z++ {
		var op string
		fmt.Fscan(in, &op)
		if op == "T" {
			var id int
			var d uint64
			fmt.Fscan(in, &id, &d)
			active[id] = true
			heap.Push(h, item{d, id})
		} else if op == "C" {
			var id int
			fmt.Fscan(in, &id)
			active[id] = false
		} else {
			var ready int
			fmt.Fscan(in, &ready)
			for h.Len() > 0 && !active[(*h)[0].id] {
				heap.Pop(h)
			}
			if ready == 0 && h.Len() > 0 && (*h)[0].d > clock {
				clock = (*h)[0].d
			}
			f := []int{}
			for h.Len() > 0 && (*h)[0].d <= clock {
				x := heap.Pop(h).(item)
				if active[x.id] {
					active[x.id] = false
					f = append(f, x.id)
				}
			}
			fmt.Fprint(out, clock, " ", ready, " ", len(f))
			for _, id := range f {
				fmt.Fprint(out, " ", id)
			}
			fmt.Fprintln(out)
		}
	}
}
