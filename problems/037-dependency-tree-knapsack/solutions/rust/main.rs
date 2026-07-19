use std::io::{self, Read};
fn dfs(u: usize, ch: &Vec<Vec<usize>>, order: &mut Vec<usize>, after: &mut Vec<usize>) {
    let pos = order.len();
    order.push(u);
    after.push(0);
    for &v in &ch[u] {
        dfs(v, ch, order, after);
    }
    after[pos] = order.len();
}
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let n: usize = t.next().unwrap().parse().unwrap();
    let cmax: usize = t.next().unwrap().parse().unwrap();
    let mut ch = vec![Vec::new(); n + 1];
    let mut size = vec![0usize; n + 1];
    let mut value = vec![0u64; n + 1];
    for i in 1..=n {
        let p: usize = t.next().unwrap().parse().unwrap();
        size[i] = t.next().unwrap().parse().unwrap();
        value[i] = t.next().unwrap().parse().unwrap();
        ch[p].push(i);
    }
    let (mut order, mut after) = (Vec::new(), Vec::new());
    for &u in &ch[0] {
        dfs(u, &ch, &mut order, &mut after);
    }
    let mut dp = vec![vec![0u64; cmax + 1]; n + 1];
    for i in (0..n).rev() {
        let u = order[i];
        for c in 0..=cmax {
            dp[i][c] = dp[after[i]][c];
            if c >= size[u] {
                dp[i][c] = dp[i][c].max(value[u] + dp[i + 1][c - size[u]]);
            }
        }
    }
    println!("{}", dp[0][cmax]);
}
