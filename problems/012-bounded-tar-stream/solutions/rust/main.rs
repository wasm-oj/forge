use std::io::{self, BufRead};
fn ok(s: &str) -> bool {
    !s.starts_with('/')
        && !s.ends_with('/')
        && s.split('/').all(|x| {
            !x.is_empty()
                && x != "."
                && x != ".."
                && x.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
        })
}
fn main() {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let header = lines.next().unwrap().unwrap();
    let mut header_tokens = header.split_whitespace();
    let n: usize = header_tokens.next().unwrap().parse().unwrap();
    let ln: u64 = header_tokens.next().unwrap().parse().unwrap();
    let lb: u64 = header_tokens.next().unwrap().parse().unwrap();
    let (mut off, mut cnt, mut used) = (0u64, 0u64, 0u64);
    let mut pending: Option<String> = None;
    for i in 1..=n {
        let line = lines.next().unwrap().unwrap();
        let mut tokens = line.split_whitespace();
        let got: u64 = tokens.next().unwrap().parse().unwrap();
        let t = tokens.next().unwrap().as_bytes()[0];
        let name = tokens.next().unwrap();
        let z: u64 = tokens.next().unwrap().parse().unwrap();
        let a: u64 = tokens.next().unwrap().parse().unwrap();
        let b: u64 = tokens.next().unwrap().parse().unwrap();
        let meta = t == b'G' || t == b'P';
        let actual = t == b'F' || t == b'D';
        let err = if got != off {
            Some("OFFSET")
        } else if a != b {
            Some("CHECKSUM")
        } else if !b"FDGP".contains(&t) {
            Some("TYPE")
        } else if meta && pending.is_some() {
            Some("STATE")
        } else if meta && z != name.len() as u64 + 1 {
            Some("META_SIZE")
        } else if meta && !ok(name) {
            Some("PATH")
        } else if actual && !ok(pending.as_deref().unwrap_or(name)) {
            Some("PATH")
        } else if t == b'D' && z != 0 {
            Some("ENTRY_SIZE")
        } else if t == b'F' && (cnt == ln || z > lb - used) {
            Some("LIMIT")
        } else {
            None
        };
        if let Some(e) = err {
            println!("REJECT {i} {e}");
            return;
        }
        off += 512 + ((z + 511) / 512) * 512;
        if meta {
            pending = Some(name.to_string())
        } else {
            pending = None;
            if t == b'F' {
                cnt += 1;
                used += z
            }
        }
    }
    if pending.is_some() {
        println!("REJECT {} STATE", n + 1)
    } else {
        println!("ACCEPT {cnt} {used} {off}")
    }
}
