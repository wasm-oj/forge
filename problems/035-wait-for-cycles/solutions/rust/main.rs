use std::fmt::Write;
use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let n: usize = it.next().unwrap().parse().unwrap();
    let m: usize = it.next().unwrap().parse().unwrap();
    let (mut g, mut rg) = (vec![vec![]; n], vec![vec![]; n]);
    let mut edges = vec![];
    let mut selfloop = vec![false; n];
    for _ in 0..m {
        let u = it.next().unwrap().parse::<usize>().unwrap() - 1;
        let v = it.next().unwrap().parse::<usize>().unwrap() - 1;
        g[u].push(v);
        rg[v].push(u);
        edges.push((u, v));
        selfloop[u] |= u == v;
    }
    let mut seen = vec![false; n];
    let mut cur = vec![0; n];
    let mut order = vec![];
    for root in 0..n {
        if seen[root] {
            continue;
        }
        seen[root] = true;
        let mut st = vec![root];
        while let Some(&u) = st.last() {
            if cur[u] < g[u].len() {
                let v = g[u][cur[u]];
                cur[u] += 1;
                if !seen[v] {
                    seen[v] = true;
                    st.push(v)
                }
            } else {
                order.push(u);
                st.pop();
            }
        }
    }
    let mut comp = vec![usize::MAX; n];
    let mut cc = 0;
    for &root in order.iter().rev() {
        if comp[root] != usize::MAX {
            continue;
        }
        comp[root] = cc;
        let mut st = vec![root];
        while let Some(u) = st.pop() {
            for &v in &rg[u] {
                if comp[v] == usize::MAX {
                    comp[v] = cc;
                    st.push(v)
                }
            }
        }
        cc += 1
    }
    let mut mem = vec![vec![]; cc];
    for i in 0..n {
        mem[comp[i]].push(i)
    }
    let mut indeg = vec![false; cc];
    for &(u, v) in &edges {
        if comp[u] != comp[v] {
            indeg[comp[v]] = true
        }
    }
    let wake = indeg.iter().filter(|&&x| !x).count();
    let mut cyc = vec![];
    for i in 0..n {
        let c = comp[i];
        if mem[c][0] == i && (mem[c].len() > 1 || selfloop[i]) {
            cyc.push(c)
        }
    }
    let mut out = format!("{} {}\n", cyc.len(), wake);
    for c in cyc {
        write!(out, "{}", mem[c].len()).unwrap();
        for &v in &mem[c] {
            write!(out, " {}", v + 1).unwrap()
        }
        out.push('\n');
    }
    print!("{out}");
}
