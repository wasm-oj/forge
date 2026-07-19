use std::io::{self, Read};
fn main() {
    let mut s = String::new();
    io::stdin().read_to_string(&mut s).unwrap();
    let mut t = s.split_whitespace();
    let n: usize = t.next().unwrap().parse().unwrap();
    let mut out = String::new();
    for _ in 0..n {
        let path = t.next().unwrap();
        let mut st = Vec::new();
        let mut bad = false;
        for x in path.split('/') {
            if x.is_empty() || x == "." {
                continue;
            }
            if x == ".." {
                if st.pop().is_none() {
                    bad = true;
                    break;
                }
            } else {
                st.push(x)
            }
        }
        if bad {
            out += "INVALID\n"
        } else if st.is_empty() {
            out += "/\n"
        } else {
            for x in st {
                out.push('/');
                out += x;
            }
            out.push('\n');
        }
    }
    print!("{}", out);
}
