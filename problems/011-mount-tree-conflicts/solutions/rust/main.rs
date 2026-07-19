use std::io::{self, Read};

#[derive(Clone, Copy)]
struct Node {
    first_child: u32,
    next_sibling: u32,
    exact_min: u32,
    file_min: u32,
    desc_min: u32,
    ch: u8,
}

fn find_or_create_child(nodes: &mut Vec<Node>, parent: u32, ch: u8, infinity: u32) -> u32 {
    let mut child = nodes[parent as usize].first_child;
    while child != 0 {
        if nodes[child as usize].ch == ch {
            return child;
        }
        child = nodes[child as usize].next_sibling;
    }
    let child = nodes.len() as u32;
    let next_sibling = nodes[parent as usize].first_child;
    nodes.push(Node {
        first_child: 0,
        next_sibling,
        exact_min: infinity,
        file_min: infinity,
        desc_min: infinity,
        ch,
    });
    nodes[parent as usize].first_child = child;
    child
}

fn main() {
    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input).unwrap();
    let text = std::str::from_utf8(&input).unwrap();
    let mut tokens = text.split_ascii_whitespace();
    let n: u32 = tokens.next().unwrap().parse().unwrap();
    let infinity = n + 1;
    let mut nodes = vec![Node {
        first_child: 0,
        next_sibling: 0,
        exact_min: infinity,
        file_min: infinity,
        desc_min: infinity,
        ch: 0,
    }];

    for j in 1..=n {
        let kind = tokens.next().unwrap().as_bytes()[0];
        let path = tokens.next().unwrap().as_bytes();
        let mut visited = Vec::with_capacity(path.len());
        let mut current = 0_u32;
        let mut best = infinity;

        for (position, &ch) in path.iter().enumerate() {
            current = find_or_create_child(&mut nodes, current, ch, infinity);
            visited.push(current);
            if position + 1 < path.len() && (position == 0 || path[position + 1] == b'/') {
                best = best.min(nodes[current as usize].file_min);
            }
        }
        best = best.min(nodes[current as usize].exact_min);
        if kind == b'F' {
            best = best.min(nodes[current as usize].desc_min);
        }

        if best != infinity {
            println!("CONFLICT {best} {j}");
            return;
        }

        for position in 0..path.len() - 1 {
            if position == 0 || path[position + 1] == b'/' {
                let node = visited[position] as usize;
                nodes[node].desc_min = nodes[node].desc_min.min(j);
            }
        }
        nodes[current as usize].exact_min = nodes[current as usize].exact_min.min(j);
        if kind == b'F' {
            nodes[current as usize].file_min = nodes[current as usize].file_min.min(j);
        }
    }

    println!("VALID");
}
