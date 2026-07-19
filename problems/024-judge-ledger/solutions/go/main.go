package main

import (
	"bufio"
	"fmt"
	"os"
)

func max(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
func rmq(t []int64, b, l, r int) int64 {
	l += b - 1
	r += b - 1
	var z int64
	for l <= r {
		if l&1 == 1 {
			z = max(z, t[l])
			l++
		}
		if r&1 == 0 {
			z = max(z, t[r])
			r--
		}
		l /= 2
		r /= 2
	}
	return z
}
func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n, q int
	fmt.Fscan(in, &n, &q)
	bad := make([]int, n+2)
	nb := make([]int, n+2)
	u := make([][]int, 4)
	s := make([][]int64, 2)
	for j := range u {
		u[j] = make([]int, n+1)
	}
	for j := range s {
		s[j] = make([]int64, n+1)
	}
	b := 1
	for b < n {
		b *= 2
	}
	tm := make([]int64, 2*b)
	tv := make([]int64, 2*b)
	for i := 1; i <= n; i++ {
		var a [4]int64
		fmt.Fscan(in, &bad[i], &a[0], &a[1], &a[2], &a[3])
		for j := 0; j < 4; j++ {
			u[j][i] = u[j][i-1]
			if a[j] < 0 {
				u[j][i]++
			}
		}
		for j := 0; j < 2; j++ {
			s[j][i] = s[j][i-1] + max(0, a[j])
		}
		tm[b+i-1] = max(0, a[2])
		tv[b+i-1] = max(0, a[3])
	}
	for i := b - 1; i > 0; i-- {
		tm[i] = max(tm[i*2], tm[i*2+1])
		tv[i] = max(tv[i*2], tv[i*2+1])
	}
	nb[n+1] = n + 1
	for i := n; i > 0; i-- {
		if bad[i] > 0 {
			nb[i] = i
		} else {
			nb[i] = nb[i+1]
		}
	}
	for ; q > 0; q-- {
		var l, r, f int
		fmt.Fscan(in, &l, &r, &f)
		e := r
		if f == 1 && nb[l] <= r {
			e = nb[l]
		}
		v := 0
		if nb[l] <= e {
			v = bad[nb[l]]
		}
		fmt.Fprint(out, e-l+1, " ", v)
		for j := 0; j < 2; j++ {
			if u[j][e] > u[j][l-1] {
				fmt.Fprint(out, " null")
			} else {
				fmt.Fprint(out, " ", s[j][e]-s[j][l-1])
			}
		}
		for j := 2; j < 4; j++ {
			if u[j][e] > u[j][l-1] {
				fmt.Fprint(out, " null")
			} else if j == 2 {
				fmt.Fprint(out, " ", rmq(tm, b, l, e))
			} else {
				fmt.Fprint(out, " ", rmq(tv, b, l, e))
			}
		}
		fmt.Fprintln(out)
	}
}
