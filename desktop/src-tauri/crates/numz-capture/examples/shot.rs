//! A command-line probe of the native backend, for the verification scripts: `shot support | windows | screen <out.png> | window <id> <out.png>`.
//! It takes one picture and exits. It is not part of the app.

use numz_capture::native_backend;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let backend = native_backend();
    let show = |e: numz_capture::CaptureError| -> ! {
        eprintln!("ERROR {}", e.code());
        std::process::exit(2)
    };
    match args.first().map(String::as_str) {
        Some("support") => println!("{:?}", backend.support()),
        Some("windows") => {
            for w in backend.windows().unwrap_or_else(|e| show(e)) {
                println!("{}\t{}\t{}\t{}x{}", w.id, w.title, w.app, w.width, w.height);
            }
        }
        Some("screen") => {
            let image = backend.capture_screen().unwrap_or_else(|e| show(e));
            image.save(&args[1]).expect("write png");
            println!("{}x{}", image.width(), image.height());
        }
        Some("window") => {
            let image = backend.capture_window(&args[1]).unwrap_or_else(|e| show(e));
            image.save(&args[2]).expect("write png");
            println!("{}x{}", image.width(), image.height());
        }
        _ => eprintln!("usage: shot support | windows | screen <out.png> | window <id> <out.png>"),
    }
}
