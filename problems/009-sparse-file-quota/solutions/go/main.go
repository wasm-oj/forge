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
	var f, n int
	var cap uint64
	if _, e := fmt.Fscan(in, &f, &n, &cap); e != nil {
		return
	}
	size := make([]uint64, f+1)
	cur := make([]uint64, f+1)
	var used, peak uint64
	for ; n > 0; n-- {
		var op string
		var x int
		var v uint64
		fmt.Fscan(in, &op, &x, &v)
		err := false
		if op == "SEEK" {
			cur[x] = v
		} else {
			ns := v
			if op == "WRITE" {
				ns = size[x]
				if v > 0 && cur[x]+v > ns {
					ns = cur[x] + v
				}
			}
			if ns > size[x] && ns-size[x] > cap-used {
				err = true
			} else {
				if ns >= size[x] {
					used += ns - size[x]
				} else {
					used -= size[x] - ns
				}
				size[x] = ns
				if op == "WRITE" && v > 0 {
					cur[x] += v
				}
			}
		}
		if used > peak {
			peak = used
		}
		if err {
			fmt.Fprint(out, "ERR QUOTA")
		} else {
			fmt.Fprint(out, "OK")
		}
		fmt.Fprintln(out, "", size[x], cur[x], used)
	}
	fmt.Fprintln(out, "SUMMARY", used, peak)
}
