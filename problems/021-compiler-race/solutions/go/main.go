package main

import (
	"bufio"
	"fmt"
	"os"
)

type Job struct {
	key   string
	epoch int
	kind  byte
	alive bool
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n int
	fmt.Fscan(in, &n)
	by := map[string]int{}
	a := make([]Job, 1, n+1)
	ep, bg := 0, 0
	for ; n > 0; n-- {
		var ts string
		fmt.Fscan(in, &ts)
		t := ts[0]
		if t == 'B' || t == 'F' {
			var k string
			fmt.Fscan(in, &k)
			id := by[k]
			live := id > 0 && a[id].alive && (a[id].kind == 'F' || a[id].epoch == ep)
			if live {
				fmt.Fprintln(out, "JOIN", id)
			} else {
				a = append(a, Job{k, ep, t, true})
				id = len(a) - 1
				by[k] = id
				if t == 'B' {
					bg++
				}
				fmt.Fprintln(out, "NEW", id)
			}
		} else if t == 'S' {
			fmt.Fprintln(out, "CANCEL", bg)
			bg = 0
			ep++
		} else {
			var id int
			fmt.Fscan(in, &id)
			live := id < len(a) && a[id].alive && (a[id].kind == 'F' || a[id].epoch == ep)
			if !live {
				fmt.Fprintln(out, "STALE")
			} else {
				a[id].alive = false
				if a[id].kind == 'B' {
					bg--
				}
				if by[a[id].key] == id {
					delete(by, a[id].key)
				}
				fmt.Fprintln(out, "DONE")
			}
		}
	}
}
