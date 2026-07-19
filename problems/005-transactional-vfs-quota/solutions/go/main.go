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
	var p, n, limit int
	var cap uint64
	if _, e := fmt.Fscan(in, &p, &n, &cap, &limit); e != nil {
		return
	}
	ex := make([]bool, p+1)
	sz := make([]uint64, p+1)
	var used, peakb uint64
	ino, peaki, sticky := 0, 0, 0
	for z := 0; z < n; z++ {
		var op string
		var x int
		fmt.Fscan(in, &op, &x)
		err := ""
		if op == "CREATE" {
			if ex[x] {
				err = "EXISTS"
			} else if ino == limit {
				err = "INODES"
			} else {
				ex[x] = true
				ino++
			}
		} else if op == "UNLINK" {
			if !ex[x] {
				err = "NOENT"
			} else {
				used -= sz[x]
				sz[x] = 0
				ex[x] = false
				ino--
			}
		} else {
			var v uint64
			if op == "WRITE" {
				var off, length uint64
				fmt.Fscan(in, &off, &length)
				v = sz[x]
				if length > 0 && off+length > v {
					v = off + length
				}
			} else {
				fmt.Fscan(in, &v)
			}
			if !ex[x] {
				err = "NOENT"
			} else if v > sz[x] && v-sz[x] > cap-used {
				err = "BYTES"
			} else {
				if v >= sz[x] {
					used += v - sz[x]
				} else {
					used -= sz[x] - v
				}
				sz[x] = v
			}
		}
		if err == "" {
			fmt.Fprintln(out, "OK")
		} else {
			fmt.Fprintln(out, "ERR", err)
			if err == "BYTES" || err == "INODES" {
				sticky = 1
			}
		}
		if used > peakb {
			peakb = used
		}
		if ino > peaki {
			peaki = ino
		}
	}
	fmt.Fprintln(out, "SUMMARY", used, ino, peakb, peaki, sticky)
}
