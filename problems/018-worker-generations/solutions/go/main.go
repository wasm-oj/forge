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
	var b, used uint64
	fmt.Fscan(in, &n, &b)
	cur := ""
	gen, reject := 0, 0
	for ; n > 0; n-- {
		var f string
		var s uint64
		fmt.Fscan(in, &f, &s)
		if s == 0 {
			fmt.Fprintln(out, "CACHE")
			continue
		}
		if s > 8 || s > b {
			fmt.Fprintln(out, "REJECT")
			reject++
			continue
		}
		if cur != f || used+s > b {
			cur = f
			used = 0
			gen++
		}
		used += s
		fmt.Fprintln(out, "WORKER", gen)
	}
	fmt.Fprintln(out, "SUMMARY", gen, reject)
}
