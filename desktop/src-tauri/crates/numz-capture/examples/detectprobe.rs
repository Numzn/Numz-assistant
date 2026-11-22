//! A command-line probe of the change detector, for the verification scripts: `detectprobe before.png after.png` feeds the first picture three
//! times and the second three times, and prints what the detector decided at every look. It is not part of the app.

use numz_capture::detect::{signature, Config, Detector};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: detectprobe before.png after.png");
        std::process::exit(2);
    }
    let load = |path: &str| image::open(path).unwrap_or_else(|e| panic!("{path}: {e}")).to_rgba8();
    let (before, after) = (signature(&load(&args[0])), signature(&load(&args[1])));
    let mut detector = Detector::new(Config::default());
    for (name, sig) in [("before", &before), ("before", &before), ("before", &before), ("after", &after), ("after", &after), ("after", &after)] {
        println!("{name}: {:?}", detector.observe(sig.clone()));
    }
}
