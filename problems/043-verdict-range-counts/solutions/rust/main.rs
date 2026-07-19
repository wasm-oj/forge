use std::io::{self, Read};

fn verdict_index(value: u8) -> usize {
    match value {
        b'A' => 0,
        b'W' => 1,
        b'R' => 2,
        _ => 3,
    }
}

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut tokens = input.split_whitespace();
    let n: usize = tokens.next().unwrap().parse().unwrap();
    let q: usize = tokens.next().unwrap().parse().unwrap();
    let verdicts = tokens.next().unwrap().as_bytes();
    let mut prefix = vec![[0_u32; 4]; n + 1];
    for index in 1..=n {
        prefix[index] = prefix[index - 1];
        prefix[index][verdict_index(verdicts[index - 1])] += 1;
    }
    let mut output = String::new();
    for _ in 0..q {
        let left: usize = tokens.next().unwrap().parse().unwrap();
        let right: usize = tokens.next().unwrap().parse().unwrap();
        let kind = verdict_index(tokens.next().unwrap().as_bytes()[0]);
        let answer = prefix[right][kind] - prefix[left - 1][kind];
        output.push_str(&format!("{answer}\n"));
    }
    print!("{output}");
}
