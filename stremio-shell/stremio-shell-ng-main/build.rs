use chrono::{Datelike, Local};
use std::{env, fs, io::Cursor, path::PathBuf};

fn main() {
    let now = Local::now();
    let copyright = format!("Copyright © {} Smart Code OOD", now.year());
    let exe_name = format!("{}.exe", env::var("CARGO_PKG_NAME").unwrap());
    let mut res = winres::WindowsResource::new();
    res.set_manifest(
        r#"
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0" xmlns:asmv3="urn:schemas-microsoft-com:asm.v3">
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
    <asmv3:application>
        <asmv3:windowsSettings>
            <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
            <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
        </asmv3:windowsSettings>
    </asmv3:application>
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
            if env::var("MYSTREMIO_SKIP_LIBMPV").ok().as_deref() == Some("1") {
                println!("cargo:warning=MYSTREMIO_SKIP_LIBMPV=1; skipping libmpv copy (CI/link-only)");
            } else {
                panic!(
                    "Missing {}. Run: npm run prepare (from stremio-custom-shell) or place libmpv-2_x64.zip in the project root.",
                    archive
                );
            }
        }
    }

    let preboot_src = PathBuf::from("assets/custom_preboot.js");
    let preboot_dst = PathBuf::from("webui/mystremio-preboot.js");
    println!("cargo:rerun-if-changed=assets/custom_preboot.js");
    if preboot_src.exists() {
        if let Some(parent) = preboot_dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Err(err) = fs::copy(&preboot_src, &preboot_dst) {
            println!("cargo:warning=Could not generate webui/mystremio-preboot.js: {err}");
        }
    }
}
