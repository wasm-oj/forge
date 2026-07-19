use std::collections::VecDeque;
use std::io::{self, Read};

fn main() {
    const MOD: u64 = 1_000_000_007;
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut tokens = input.split_whitespace();
    let n: usize = tokens.next().unwrap().parse().unwrap();
    let m: usize = tokens.next().unwrap().parse().unwrap();
    let duration: Vec<u64> = (0..n)
        .map(|_| tokens.next().unwrap().parse().unwrap())
        .collect();
    let mut graph = vec![Vec::<usize>::new(); n];
    let mut indegree = vec![0usize; n];
    let mut outdegree = vec![0usize; n];
    for _ in 0..m {
        let u: usize = tokens.next().unwrap().parse::<usize>().unwrap() - 1;
        let v: usize = tokens.next().unwrap().parse::<usize>().unwrap() - 1;
        graph[u].push(v);
        indegree[v] += 1;
        outdegree[u] += 1;
    }
    let mut best = vec![0u64; n];
    let mut ways = vec![0u64; n];
    let mut queue = VecDeque::new();
    for node in 0..n {
        if indegree[node] == 0 {
            best[node] = duration[node];
            ways[node] = 1;
            queue.push_back(node);
        }
    }
    while let Some(node) = queue.pop_front() {
        for &target in &graph[node] {
            let candidate = best[node] + duration[target];
            if candidate > best[target] {
                best[target] = candidate;
                ways[target] = ways[node];
            } else if candidate == best[target] {
                ways[target] = (ways[target] + ways[node]) % MOD;
            }
            indegree[target] -= 1;
            if indegree[target] == 0 {
                queue.push_back(target);
            }
        }
    }
    let mut answer = 0u64;
    let mut count = 0u64;
    for node in 0..n {
        if outdegree[node] != 0 {
            continue;
        }
        if best[node] > answer {
            answer = best[node];
            count = ways[node];
        } else if best[node] == answer {
            count = (count + ways[node]) % MOD;
        }
    }
    println!("{answer} {count}");
}
