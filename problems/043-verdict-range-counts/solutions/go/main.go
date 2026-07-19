package main

import (
	"bufio"
	"fmt"
	"os"
)

func verdictIndex(value byte) int {
	switch value {
	case 'A':
		return 0
	case 'W':
		return 1
	case 'R':
		return 2
	default:
		return 3
	}
}

func main() {
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := bufio.NewWriterSize(os.Stdout, 1<<20)
	defer out.Flush()
	var n, q int
	var verdicts string
	if _, err := fmt.Fscan(in, &n, &q, &verdicts); err != nil {
		return
	}
	prefix := make([][4]uint32, n+1)
	for i := 1; i <= n; i++ {
		prefix[i] = prefix[i-1]
		prefix[i][verdictIndex(verdicts[i-1])]++
	}
	for query := 0; query < q; query++ {
		var left, right int
		var verdict string
		fmt.Fscan(in, &left, &right, &verdict)
		kind := verdictIndex(verdict[0])
		fmt.Fprintln(out, prefix[right][kind]-prefix[left-1][kind])
	}
}
