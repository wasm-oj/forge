package main

import (
	"bufio"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n int
	fmt.Fscan(in, &n)
	s := map[int]byte{}
	q := make([]int, 0, n)
	head, active, waiting := 0, 0, 0
	for ; n > 0; n-- {
		var t string
		fmt.Fscan(in, &t)
		if t == "A" {
			var x int
			fmt.Fscan(in, &x)
			if active == 0 {
				active = x
				s[x] = 2
			} else {
				s[x] = 1
				q = append(q, x)
				waiting++
			}
		} else if t == "C" {
			var x int
			fmt.Fscan(in, &x)
			if s[x] == 1 {
				s[x] = 3
				waiting--
			} else if s[x] == 2 {
				s[x] = 3
				active = 0
			}
		} else if active != 0 {
			s[active] = 3
			active = 0
		}
		for active == 0 && head < len(q) {
			x := q[head]
			head++
			if s[x] == 1 {
				s[x] = 2
				active = x
				waiting--
				break
			}
		}
		fmt.Fprintln(out, active, waiting)
	}
}
