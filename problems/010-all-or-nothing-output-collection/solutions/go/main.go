package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
)

type file struct {
	p    string
	m, a uint64
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n, q int
	var u uint64
	if _, e := fmt.Fscan(in, &n, &q, &u); e != nil {
		return
	}
	f := make([]file, n)
	for i := range f {
		fmt.Fscan(in, &f[i].p, &f[i].m, &f[i].a)
	}
	sort.Slice(f, func(i, j int) bool { return f[i].p < f[j].p })
	pre := make([]uint64, n+1)
	mismatch := n
	for i := 0; i < n; i++ {
		pre[i+1] = pre[i] + f[i].m
		if mismatch == n && f[i].m != f[i].a {
			mismatch = i
		}
	}
	k := 0
	for ; q > 0; q-- {
		var b uint64
		fmt.Fscan(in, &b)
		if b < u {
			fmt.Fprintln(out, "ERR QUOTA -")
			continue
		}
		cap := b - u
		for k < n && pre[k+1] <= cap {
			k++
		}
		if k < mismatch {
			fmt.Fprintln(out, "ERR QUOTA", f[k].p)
		} else if mismatch < n {
			fmt.Fprintln(out, "ERR MISMATCH", f[mismatch].p)
		} else if k < n {
			fmt.Fprintln(out, "ERR QUOTA", f[k].p)
		} else {
			fmt.Fprintln(out, "OK", n, u+pre[n])
		}
	}
}
