use std::collections::VecDeque;
use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let l: usize = it.next().unwrap().parse().unwrap();
    let r: usize = it.next().unwrap().parse().unwrap();
    let m: usize = it.next().unwrap().parse().unwrap();
    let mut g = vec![vec![]; l];
    for _ in 0..m {
        let u = it.next().unwrap().parse::<usize>().unwrap() - 1;
        let v = it.next().unwrap().parse::<usize>().unwrap() - 1;
        g[u].push(v);
    }
    let mut pu = vec![usize::MAX; l];
    let mut pv = vec![usize::MAX; r];
    let mut dist = vec![-1i32; l];
    let mut matching = 0;
    loop {
        let mut q = VecDeque::new();
        for u in 0..l {
            dist[u] = if pu[u] == usize::MAX {
                q.push_back(u);
                0
            } else {
                -1
            }
        }
        let mut terminal = -1;
        while let Some(u) = q.pop_front() {
            if terminal >= 0 && dist[u] >= terminal {
                continue;
            }
            for &v in &g[u] {
                let w = pv[v];
                if w == usize::MAX {
                    terminal = dist[u]
                } else if dist[w] < 0 {
                    dist[w] = dist[u] + 1;
                    q.push_back(w)
                }
            }
        }
        if terminal < 0 {
            break;
        }
        let mut cur = vec![0; l];
        for root in 0..l {
            if pu[root] != usize::MAX {
                continue;
            }
            let (mut su, mut sv) = (vec![root], vec![]);
            let mut ok = false;
            while !su.is_empty() && !ok {
                let u = *su.last().unwrap();
                let mut down = false;
                while cur[u] < g[u].len() {
                    let v = g[u][cur[u]];
                    cur[u] += 1;
                    let w = pv[v];
                    if w == usize::MAX && dist[u] == terminal {
                        pu[u] = v;
                        pv[v] = u;
                        for i in (0..sv.len()).rev() {
                            pu[su[i]] = sv[i];
                            pv[sv[i]] = su[i]
                        }
                        ok = true;
                        break;
                    }
                    if w != usize::MAX && dist[u] < terminal && dist[w] == dist[u] + 1 {
                        sv.push(v);
                        su.push(w);
                        down = true;
                        break;
                    }
                }
                if !ok && !down {
                    dist[u] = -1;
                    su.pop();
                    sv.pop();
                }
            }
            if ok {
                matching += 1
            }
        }
    }
    println!("{matching}");
}
