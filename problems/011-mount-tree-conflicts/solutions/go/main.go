package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
)

type scanner struct {
	data []byte
	pos  int
}

func (s *scanner) next() []byte {
	for s.pos < len(s.data) && s.data[s.pos] <= ' ' {
		s.pos++
	}
	start := s.pos
	for s.pos < len(s.data) && s.data[s.pos] > ' ' {
		s.pos++
	}
	return s.data[start:s.pos]
}

func parseInt(token []byte) int32 {
	var value int32
	for _, digit := range token {
		value = value*10 + int32(digit-'0')
	}
	return value
}

type node struct {
	firstChild  int32
	nextSibling int32
	exactMin    int32
	fileMin     int32
	descMin     int32
	ch          byte
}

func findOrCreateChild(nodes *[]node, parent int32, ch byte, infinity int32) int32 {
	for child := (*nodes)[parent].firstChild; child != 0; child = (*nodes)[child].nextSibling {
		if (*nodes)[child].ch == ch {
			return child
		}
	}
	child := int32(len(*nodes))
	nextSibling := (*nodes)[parent].firstChild
	*nodes = append(*nodes, node{0, nextSibling, infinity, infinity, infinity, ch})
	(*nodes)[parent].firstChild = child
	return child
}

func main() {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		panic(err)
	}
	in := scanner{data: data}
	n := parseInt(in.next())
	infinity := n + 1
	nodes := []node{{0, 0, infinity, infinity, infinity, 0}}
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	for j := int32(1); j <= n; j++ {
		kind := in.next()[0]
		path := in.next()
		visited := make([]int32, 0, len(path))
		var current int32
		best := infinity

		for position, ch := range path {
			current = findOrCreateChild(&nodes, current, ch, infinity)
			visited = append(visited, current)
			if position+1 < len(path) && (position == 0 || path[position+1] == '/') && nodes[current].fileMin < best {
				best = nodes[current].fileMin
			}
		}
		if nodes[current].exactMin < best {
			best = nodes[current].exactMin
		}
		if kind == 'F' && nodes[current].descMin < best {
			best = nodes[current].descMin
		}

		if best != infinity {
			fmt.Fprintln(out, "CONFLICT", best, j)
			return
		}

		for position := 0; position+1 < len(path); position++ {
			if position == 0 || path[position+1] == '/' {
				at := visited[position]
				if j < nodes[at].descMin {
					nodes[at].descMin = j
				}
			}
		}
		if j < nodes[current].exactMin {
			nodes[current].exactMin = j
		}
		if kind == 'F' && j < nodes[current].fileMin {
			nodes[current].fileMin = j
		}
	}

	fmt.Fprintln(out, "VALID")
}
