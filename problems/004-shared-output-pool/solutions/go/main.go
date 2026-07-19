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
	var n, q int
	if _, e := fmt.Fscan(in, &n, &q); e != nil {
		return
	}
	s := make([]string, n)
	a := make([]uint64, n)
	for j := 0; j < n; j++ {
		fmt.Fscan(in, &s[j], &a[j])
	}
	i := 0
	var used uint64
	c := [3]uint64{}
	for ; q > 0; q-- {
		var b uint64
		fmt.Fscan(in, &b)
		for i < n && a[i] <= b-used {
			used += a[i]
			k := 2
			if s[i] == "O" {
				k = 0
			} else if s[i] == "E" {
				k = 1
			}
			c[k] += a[i]
			i++
		}
		d := c
		fail := 0
		if i < n {
			fail = i + 1
			k := 2
			if s[i] == "O" {
				k = 0
			} else if s[i] == "E" {
				k = 1
			}
			d[k] += b - used
		}
		fmt.Fprintln(out, fail, d[0], d[1], d[2])
	}
}
