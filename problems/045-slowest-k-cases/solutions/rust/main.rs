use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::io::{self, BufWriter, Read, Write};

#[derive(Clone, Copy, Eq, PartialEq)]
struct Case {
    cost: u64,
    index: usize,
}

impl Ord for Case {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .cost
            .cmp(&self.cost)
            .then_with(|| self.index.cmp(&other.index))
    }
}

impl PartialOrd for Case {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn better(left: Case, right: Case) -> bool {
    left.cost > right.cost || (left.cost == right.cost && left.index < right.index)
}

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut tokens = input.split_whitespace();
    let n: usize = tokens.next().unwrap().parse().unwrap();
    let k: usize = tokens.next().unwrap().parse().unwrap();
    let mut heap = BinaryHeap::with_capacity(k);
    let mut output = BufWriter::new(io::stdout().lock());
    for index in 1..=n {
        let cost: u64 = tokens.next().unwrap().parse().unwrap();
        let candidate = Case { cost, index };
        if heap.len() < k {
            heap.push(candidate);
        } else if better(candidate, *heap.peek().unwrap()) {
            heap.pop();
            heap.push(candidate);
        }
        if index >= k {
            let answer = heap.peek().unwrap();
            writeln!(output, "{} {}", answer.index, answer.cost).unwrap();
        }
    }
}
