package main

import (
	"bufio"
	"fmt"
	"os"
)

type A struct {
	t byte
	k int64
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var C int64
	var n [2]int
	fmt.Fscan(in, &C, &n[0], &n[1])
	a := [2][]A{}
	for w := 0; w < 2; w++ {
		for i := 0; i < n[w]; i++ {
			var t string
			var k int64
			fmt.Fscan(in, &t)
			if t != "C" {
				fmt.Fscan(in, &k)
			}
			a[w] = append(a[w], A{t[0], k})
		}
	}
	pc := [2]int{}
	closed := [2]bool{n[0] == 0, n[1] == 0}
	occ := [2]int64{}
	var steps int64
	for {
		if pc == n {
			fmt.Fprintln(out, "SUCCESS", steps, occ[0], occ[1])
			return
		}
		progress := false
		for w := 0; w < 2; w++ {
			if pc[w] == n[w] {
				continue
			}
			x := a[w][pc[w]]
			o := 1 - w
			z := 0
			if x.t == 'W' {
				if C-occ[w] >= x.k {
					occ[w] += x.k
					z = 1
				}
			} else if x.t == 'R' {
				if occ[o] >= x.k {
					occ[o] -= x.k
					z = 1
				} else if closed[o] {
					z = -1
				}
			} else {
				closed[w] = true
				z = 1
			}
			if z < 0 {
				fmt.Fprintln(out, "FAIL", string("AB"[w]), steps, occ[0], occ[1])
				return
			}
			if z == 1 {
				pc[w]++
				steps++
				progress = true
				if pc[w] == n[w] {
					closed[w] = true
				}
			}
		}
		if !progress {
			fmt.Fprintln(out, "DEADLOCK", steps, occ[0], occ[1])
			return
		}
	}
}
