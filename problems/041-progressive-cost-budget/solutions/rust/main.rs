use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut tokens = input.split_whitespace();
    let n: usize = tokens.next().unwrap().parse().unwrap();
    let q: usize = tokens.next().unwrap().parse().unwrap();
    let costs: Vec<u64> = (0..n)
        .map(|_| tokens.next().unwrap().parse().unwrap())
        .collect();

    let mut completed = 0usize;
    let mut spent = 0u64;
    let mut output = String::new();
    for _ in 0..q {
        let budget: u64 = tokens.next().unwrap().parse().unwrap();
        while completed < n && costs[completed] <= budget - spent {
            spent += costs[completed];
            completed += 1;
        }
        output.push_str(&completed.to_string());
        output.push('\n');
    }
    print!("{output}");
}
