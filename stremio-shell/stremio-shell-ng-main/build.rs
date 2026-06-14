use chrono::{Datelike, Local};
use std::{env, fs, io::Cursor, path::PathBuf};

extern crate winres;
fn main() {
    let now = Local::now();
    let copyright = format!("Copyright © {} Smart Code OOD", now.year());
    let exe_name = format!("{}.exe", env::var("CARGO_PKG_NAME").unwrap());
    let mut res = winres::WindowsResource::new();
    res.set_manifest(
        r#"
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
    <dependency>
        <dependentAssembly>
            <assemblyIdentity
                type="win32"
                name="Microsoft.Windows.Common-Controls"
                version="6.0.0.0"
                processorArchitecture="*"
                publicKeyToken="6595b64144ccf1df"
                language="*"
            />
        </dependentAssembly>
    </dependency>
    </assembly>
    "#,
    );
    res.set("FileDescription", "MyStremio - Freedom to Stream");
    res.set("LegalCopyright", &copyright);
    res.set("OriginalFilename", &exe_name);
    res.set_icon_with_id("images/stremio.ico", "MAINICON");
    res.append_rc_content(r##"SPLASHIMAGE IMAGE "images/stremio.png""##);
    res.compile().unwrap();

    //extract libmpv-2
    let target = std::env::var("TARGET").unwrap();
    let (arch, archive, flags) = match target.as_str() {
        "x86_64-pc-windows-msvc" => ("x64", "libmpv-2_x64.zip", "/LIBPATH:.\\mpv-x64"),
        "aarch64-pc-windows-msvc" => ("arm64", "libmpv-2_arm64.zip", "/LIBPATH:.\\mpv-arm64"),
        _ => panic!("Unsupported target {}", target),
    };
    println!("cargo:rustc-env=ARCH={}", arch);
    println!("cargo:rustc-link-arg={}", flags);
    let target_dir = PathBuf::from(".");
    let archive_path = PathBuf::from(archive);
    if archive_path.exists() {
        let archive = fs::read(&archive_path).unwrap();
        zip_extract::extract(Cursor::new(archive), &target_dir, true).ok();
    } else {
        let dll_name = "libmpv-2.dll";
        let dll_sources = [
            PathBuf::from(dll_name),
            PathBuf::from(env::var("STREMIO_INSTALL").unwrap_or_default()).join(dll_name),
            PathBuf::from(env::var("LOCALAPPDATA").unwrap_or_default())
                .join("Programs")
                .join("Stremio")
                .join(dll_name),
            PathBuf::from(
                env::var("USERPROFILE").unwrap_or_default(),
            )
            .join("Documents")
            .join("StremioApp")
            .join("stremio-custom")
            .join("vendor")
            .join("mpv")
            .join(dll_name),
        ];

        let mut copied = false;
        for source in dll_sources.iter().filter(|p| !p.as_os_str().is_empty()) {
            if source.exists() {
                let _ = fs::copy(source, target_dir.join(dll_name));
                println!("cargo:warning=Using libmpv from {}", source.display());
                copied = true;
                break;
            }
        }

        if !copied {
            panic!(
                "Missing {}. Run: npm run prepare (from stremio-custom-shell) or place libmpv-2_x64.zip in the project root.",
                archive
            );
        }
    }
}
