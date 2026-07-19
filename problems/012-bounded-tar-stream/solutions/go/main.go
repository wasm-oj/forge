package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

func ok(s string) bool {
	if s == "" || s[0] == '/' || s[len(s)-1] == '/' {
		return false
	}
	for _, x := range strings.Split(s, "/") {
		if x == "" || x == "." || x == ".." {
			return false
		}
		for _, c := range x {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.ContainsRune("._-", c)) {
				return false
			}
		}
	}
	return true
}
func main() {
	in := bufio.NewReader(os.Stdin)
	var n int
	var ln, lb uint64
	fmt.Fscan(in, &n, &ln, &lb)
	var off, cnt, used uint64
	pending := ""
	for i := 1; i <= n; i++ {
		var got, z, a, b uint64
		var t, name string
		fmt.Fscan(in, &got, &t, &name, &z, &a, &b)
		meta := t == "G" || t == "P"
		actual := t == "F" || t == "D"
		eff := name
		if pending != "" {
			eff = pending
		}
		err := ""
		if got != off {
			err = "OFFSET"
		} else if a != b {
			err = "CHECKSUM"
		} else if !strings.Contains("FDGP", t) {
			err = "TYPE"
		} else if meta && pending != "" {
			err = "STATE"
		} else if meta && z != uint64(len(name)+1) {
			err = "META_SIZE"
		} else if meta && !ok(name) {
			err = "PATH"
		} else if actual && !ok(eff) {
			err = "PATH"
		} else if t == "D" && z != 0 {
			err = "ENTRY_SIZE"
		} else if t == "F" && (cnt == ln || z > lb-used) {
			err = "LIMIT"
		}
		if err != "" {
			fmt.Println("REJECT", i, err)
			return
		}
		off += 512 + ((z+511)/512)*512
		if meta {
			pending = name
		} else {
			pending = ""
			if t == "F" {
				cnt++
				used += z
			}
		}
	}
	if pending != "" {
		fmt.Println("REJECT", n+1, "STATE")
	} else {
		fmt.Println("ACCEPT", cnt, used, off)
	}
}
