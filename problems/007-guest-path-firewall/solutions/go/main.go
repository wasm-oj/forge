package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	var n int
	if _, e := fmt.Fscan(in, &n); e != nil {
		return
	}
	for ; n > 0; n-- {
		var path string
		fmt.Fscan(in, &path)
		st := []string{}
		bad := false
		for _, x := range strings.Split(path, "/") {
			if x == "" || x == "." {
				continue
			}
			if x == ".." {
				if len(st) == 0 {
					bad = true
					break
				}
				st = st[:len(st)-1]
			} else {
				st = append(st, x)
			}
		}
		if bad {
			fmt.Fprintln(out, "INVALID")
		} else if len(st) == 0 {
			fmt.Fprintln(out, "/")
		} else {
			fmt.Fprintln(out, "/"+strings.Join(st, "/"))
		}
	}
}
