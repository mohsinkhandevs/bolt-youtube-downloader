use std::process::{Command, Stdio, Child};
use std::io::{BufRead, BufReader, Read};
use std::sync::Mutex;
use std::collections::HashMap;
use tauri::{AppHandle, Manager, Emitter, State};
use tauri_plugin_dialog::DialogExt;

// Serializable structured log payload matching frontend expectations
#[derive(Clone, serde::Serialize)]
struct DownloadLog {
    slot: usize,
    line: String,
}

// Struct to store active child process alongside task context details
pub struct ActiveDownload {
    pub child: Child,
    pub task_id: String,
    pub item_index: usize,
}

// High-speed, thread-safe state container mapped by slot IDs
#[derive(Default)]
pub struct DownloadState {
    pub active_slots: Mutex<HashMap<usize, ActiveDownload>>,
    pub active_analysis: Mutex<Option<Child>>,
}

/// Helper function to kill a process group / process tree cleanly on Windows.
/// This prevents orphaned background ffmpeg and yt-dlp processes from leaking.
fn force_terminate_child(child: &mut Child) {
    let pid = child.id();
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(&["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);

        let _ = cmd.status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child.kill();
    }
}

/// Dynamically builds an augmented environment PATH string by discovering standard
/// Node.js and Deno installation paths across Windows, macOS, and Linux.
/// This guarantees yt-dlp always has access to a JavaScript runtime for signature deobfuscation.
fn get_augmented_path() -> std::ffi::OsString {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = std::env::split_paths(&path_var).collect::<Vec<_>>();

    // Standard fallback locations for Deno & Node on Windows
    #[cfg(target_os = "windows")]
    {
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let p_buf = std::path::PathBuf::from(&user_profile);
            
            // Deno standard bin: %USERPROFILE%/.deno/bin
            let deno_bin = p_buf.join(".deno").join("bin");
            if deno_bin.exists() {
                paths.insert(0, deno_bin);
            }
            
            // Scoop package manager shims: %USERPROFILE%/scoop/shims
            let scoop_shims = p_buf.join("scoop").join("shims");
            if scoop_shims.exists() {
                paths.insert(0, scoop_shims);
            }

            // NVM (Node Version Manager) for Windows symlink target
            let nvm_symlink = p_buf.join("AppData").join("Roaming").join("nvm");
            if nvm_symlink.exists() {
                paths.insert(0, nvm_symlink);
            }
        }
        
        // Winget-based packages: %LOCALAPPDATA%/Microsoft/WinGet/Packages
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            let winget_packages = std::path::PathBuf::from(&local_appdata)
                .join("Microsoft")
                .join("WinGet")
                .join("Packages");
            if winget_packages.exists() {
                if let Ok(entries) = std::fs::read_dir(&winget_packages) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            let dirname = path.file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_lowercase();
                            if dirname.contains("denoland") || dirname.contains("nodejs") {
                                paths.insert(0, path.clone());
                                let bin_folder = path.join("bin");
                                if bin_folder.exists() {
                                    paths.insert(0, bin_folder);
                                }
                            }
                        }
                    }
                }
            }
        }

        let pf_node = std::path::PathBuf::from("C:\\Program Files\\nodejs");
        if pf_node.exists() {
            paths.insert(0, pf_node);
        }
        let pf_node_x86 = std::path::PathBuf::from("C:\\Program Files (x86)\\nodejs");
        if pf_node_x86.exists() {
            paths.insert(0, pf_node_x86);
        }
        
        let choco_bin = std::path::PathBuf::from("C:\\ProgramData\\chocolatey\\bin");
        if choco_bin.exists() {
            paths.insert(0, choco_bin);
        }
    }

    // Unix-specific search folders (macOS and Linux)
    #[cfg(not(target_os = "windows"))]
    {
        paths.insert(0, std::path::PathBuf::from("/usr/local/bin"));
        paths.insert(0, std::path::PathBuf::from("/opt/homebrew/bin"));
        paths.insert(0, std::path::PathBuf::from("/usr/bin"));
        paths.insert(0, std::path::PathBuf::from("/bin"));
        
        if let Ok(home) = std::env::var("HOME") {
            let p_buf = std::path::PathBuf::from(&home);
            
            let deno_bin = p_buf.join(".deno").join("bin");
            if deno_bin.exists() {
                paths.insert(0, deno_bin);
            }
            
            let nvm_bin = p_buf.join(".nvm").join("versions").join("node");
            if nvm_bin.exists() {
                if let Ok(entries) = std::fs::read_dir(&nvm_bin) {
                    for entry in entries.flatten() {
                        let path = entry.path().join("bin");
                        if path.exists() {
                            paths.insert(0, path);
                        }
                    }
                }
            }
        }
    }

    std::env::join_paths(paths).unwrap_or(path_var)
}

// Unified helper function to locate packaged DLL-obfuscated binaries,
// copy them into the hidden user AppData cache directory as executables, and return their active paths.
fn prepare_binaries(handle: &AppHandle) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let mut search_dirs = Vec::new();
    
    // 1. Attempt packaged production resource directory first
    if let Ok(resource_dir) = handle.path().resource_dir() {
        search_dirs.push(resource_dir.join("binaries"));
    }
    
    // 2. Attempt local development directory with CWD guards
    if let Ok(current_dir) = std::env::current_dir() {
        let dev_dir = if current_dir.ends_with("src-tauri") {
            current_dir.join("binaries")
        } else {
            current_dir.join("src-tauri").join("binaries")
        };
        search_dirs.push(dev_dir);
    }

    let mut core_src = None;
    let mut codec_src = None;

    for dir in &search_dirs {
        if dir.exists() {
            let p_core = dir.join("core_module.dll");
            let p_codec = dir.join("codec_module.dll");
            if p_core.exists() && p_codec.exists() {
                core_src = Some(p_core);
                codec_src = Some(p_codec);
                break;
            }
        }
    }

    let core_src = core_src.ok_or_else(|| {
        let searched: Vec<String> = search_dirs.iter().map(|d| d.to_string_lossy().to_string()).collect();
        format!("Packaged engine core module (core_module.dll) not found. Searched paths:\n\n{}", searched.join("\n"))
    })?;

    let codec_src = codec_src.ok_or_else(|| {
        let searched: Vec<String> = search_dirs.iter().map(|d| d.to_string_lossy().to_string()).collect();
        format!("Packaged engine codec module (codec_module.dll) not found. Searched paths:\n\n{}", searched.join("\n"))
    })?;

    // 3. Resolve app cache directory
    let app_cache = handle.path().app_cache_dir()
        .map_err(|e| format!("Failed to resolve application cache directory: {}", e))?;
    
    std::fs::create_dir_all(&app_cache)
        .map_err(|e| format!("Failed to create app cache directory: {}", e))?;

    let target_core_name = if cfg!(target_os = "windows") { "nx_core.exe" } else { "nx_core" };
    let target_codec_name = if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" };

    let target_core = app_cache.join(target_core_name);
    let target_codec = app_cache.join(target_codec_name);

    // Copy if target doesn't exist or size is different
    if !target_core.exists() || std::fs::metadata(&core_src).map(|m| m.len()).unwrap_or(0) != std::fs::metadata(&target_core).map(|m| m.len()).unwrap_or(0) {
        std::fs::copy(&core_src, &target_core)
            .map_err(|e| format!("Failed to extract core engine module: {}", e))?;
        
        // On Unix-like systems, set execute permissions
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&target_core)
                .map_err(|e| format!("Failed to get permissions: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&target_core, perms)
                .map_err(|e| format!("Failed to set permissions: {}", e))?;
        }
    }

    if !target_codec.exists() || std::fs::metadata(&codec_src).map(|m| m.len()).unwrap_or(0) != std::fs::metadata(&target_codec).map(|m| m.len()).unwrap_or(0) {
        std::fs::copy(&codec_src, &target_codec)
            .map_err(|e| format!("Failed to extract codec module: {}", e))?;
        
        // On Unix-like systems, set execute permissions
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&target_codec)
                .map_err(|e| format!("Failed to get permissions: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&target_codec, perms)
                .map_err(|e| format!("Failed to set permissions: {}", e))?;
        }
    }

    Ok((target_core, app_cache))
}

fn get_cache_path(url: &str, handle: &AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(app_cache) = handle.path().app_cache_dir() {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        url.hash(&mut hasher);
        let hash_val = hasher.finish();
        let filename = format!("info_{:x}.json", hash_val);
        Some(app_cache.join(filename))
    } else {
        None
    }
}

fn cleanup_temp_files(temp_dir: &std::path::Path, sanitized_title: &str) {
    if !temp_dir.exists() || !temp_dir.is_dir() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(temp_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                    if filename.contains(sanitized_title) {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }
    // If the directory is empty, remove it
    if let Ok(mut entries) = std::fs::read_dir(temp_dir) {
        if entries.next().is_none() {
            let _ = std::fs::remove_dir(temp_dir);
        }
    }
}

#[tauri::command]
async fn get_default_download_directory(handle: AppHandle) -> Result<String, String> {
    let downloads_dir = handle.path().download_dir()
        .map_err(|e| format!("Could not resolve user download location: {}", e))?;
    Ok(downloads_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn select_download_directory(handle: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    
    handle.dialog().file().pick_folder(move |folder_path| {
        let path_str = folder_path.map(|p| p.into_path().unwrap_or_default().to_string_lossy().to_string());
        let _ = tx.send(path_str);
    });
    
    let selected = rx.recv().map_err(|e| format!("Interactive dialog pipeline failed: {}", e))?;
    Ok(selected)
}

#[tauri::command]
async fn select_cookies_file(handle: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    
    handle.dialog().file()
        .add_filter("Cookie Files (*.txt)", &["txt"])
        .pick_file(move |file_path| {
            let path_str = file_path.map(|p| p.into_path().unwrap_or_default().to_string_lossy().to_string());
            let _ = tx.send(path_str);
        });
        
    let selected = rx.recv().map_err(|e| format!("File dialog failed: {}", e))?;
    Ok(selected)
}

#[tauri::command]
async fn open_folder(path: String) -> Result<(), String> {
    let path_buf = std::path::PathBuf::from(&path);
    if path_buf.exists() && path_buf.is_dir() {
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer")
                .arg(&path_buf)
                .spawn()
                .map_err(|e| format!("Failed to execute Windows Explorer: {}", e))?;
        }
        #[cfg(target_os = "macos")]
        {
            Command::new("open")
                .arg(&path_buf)
                .spawn()
                .map_err(|e| format!("Failed to execute macOS Finder: {}", e))?;
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            Command::new("xdg-open")
                .arg(&path_buf)
                .spawn()
                .map_err(|e| format!("Failed to execute File Manager: {}", e))?;
        }
        Ok(())
    } else {
        Err("Resolved path context does not exist or is not a directory".to_string())
    }
}

#[tauri::command]
async fn resolve_unique_playlist_dir(
    custom_dir: String,
    playlist_title: String,
    handle: AppHandle,
) -> Result<String, String> {
    let base_dir = if custom_dir.is_empty() {
        handle.path().download_dir()
            .map_err(|e| format!("Could not resolve user default download location: {}", e))?
    } else {
        std::path::PathBuf::from(custom_dir)
    };

    let cleaned_title: String = playlist_title
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();

    let mut target_dir = base_dir.join(&cleaned_title);
    if !target_dir.exists() {
        return Ok(cleaned_title);
    }

    let mut counter = 1;
    while target_dir.exists() {
        let suffix_title = format!("{} ({})", cleaned_title, counter);
        target_dir = base_dir.join(&suffix_title);
        if !target_dir.exists() {
            return Ok(suffix_title);
        }
        counter += 1;
    }

    Ok(cleaned_title)
}

#[tauri::command]
async fn cancel_slot(slot_id: usize, state: State<'_, DownloadState>) -> Result<(), String> {
    if let Ok(mut guard) = state.active_slots.lock() {
        if let Some(active_download) = guard.remove(&slot_id) {
            let mut child = active_download.child;
            force_terminate_child(&mut child);
        }
    }
    Ok(())
}

/// Unified cancel task command to cleanly kill all parallel background processes belonging to a task.
/// Ensures heavy internet usage is instantly halted.
#[tauri::command]
async fn cancel_task(task_id: String, state: State<'_, DownloadState>) -> Result<(), String> {
    if let Ok(mut guard) = state.active_slots.lock() {
        let keys_to_remove: Vec<usize> = guard
            .iter()
            .filter(|(_, download)| download.task_id == task_id)
            .map(|(slot_id, _)| *slot_id)
            .collect();

        for slot_id in keys_to_remove {
            if let Some(active_download) = guard.remove(&slot_id) {
                let mut child = active_download.child;
                force_terminate_child(&mut child);
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn cancel_all(state: State<'_, DownloadState>) -> Result<(), String> {
    if let Ok(mut guard) = state.active_slots.lock() {
        for (_, active_download) in guard.drain() {
            let mut child = active_download.child;
            force_terminate_child(&mut child);
        }
    }
    if let Ok(mut guard) = state.active_analysis.lock() {
        if let Some(mut child) = guard.take() {
            force_terminate_child(&mut child);
        }
    }
    Ok(())
}

#[tauri::command]
async fn abort_analysis(state: State<'_, DownloadState>) -> Result<(), String> {
    if let Ok(mut guard) = state.active_analysis.lock() {
        if let Some(mut child) = guard.take() {
            force_terminate_child(&mut child);
        }
    }
    Ok(())
}

#[tauri::command]
async fn analyze_video(
    state: State<'_, DownloadState>, 
    url: String, 
    analysis_mode: String, // "video" | "playlist"
    cookies_source: String,
    cookies_browser: String,
    cookies_file_path: String,
    handle: AppHandle
) -> Result<String, String> {
    let (binary_path, _) = prepare_binaries(&handle)?;

    let mut args = vec![
        "-J", 
        "--no-warnings", 
        "--no-check-certificate",
        "-4",
    ];

    // DevOps Explicit command routing mapping (no fuzzy auto detect parameters)
    match analysis_mode.as_str() {
        "playlist" => {
            args.push("--yes-playlist");
            args.push("--flat-playlist");
        }
        _ => {
            args.push("--no-playlist");
        }
    }

    // Dynamic Inject Authentication Bypass Parameters
    if cookies_source == "browser" && !cookies_browser.is_empty() {
        args.push("--cookies-from-browser");
        args.push(&cookies_browser);
    } else if cookies_source == "file" && !cookies_file_path.is_empty() {
        args.push("--cookies");
        args.push(&cookies_file_path);
    }

    args.push(&url);

    let mut cmd = Command::new(binary_path);
    cmd.args(&args)
        .env("PATH", get_augmented_path()) 
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("System engine startup failed: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to link stdout channel")?;
    let stderr = child.stderr.take().ok_or("Failed to link stderr channel")?;

    {
        if let Ok(mut guard) = state.active_analysis.lock() {
            *guard = Some(child);
        }
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut stdout_reader = BufReader::new(stdout);
        let mut stdout_data = String::new();
        let read_res = stdout_reader.read_to_string(&mut stdout_data);

        let mut stderr_reader = BufReader::new(stderr);
        let mut stderr_data = String::new();
        let _ = stderr_reader.read_to_string(&mut stderr_data);

        let _ = tx.send((read_res, stdout_data, stderr_data));
    });

    let (read_res, stdout_data, stderr_data) = rx.await
        .map_err(|e| format!("Analysis communication channel error: {}", e))?;

    let child_process = {
        if let Ok(mut guard) = state.active_analysis.lock() {
            guard.take()
        } else {
            None
        }
    };

    if let Some(mut child) = child_process {
        let status = tokio::task::spawn_blocking(move || child.wait())
            .await
            .map_err(|e| format!("Wait task join failure: {}", e))?
            .map_err(|e| format!("Analysis process wait failure: {}", e))?;
        if status.success() {
            read_res.map_err(|e| format!("Failed to read analysis output: {}", e))?;
            
            // Save to cache file to speed up subsequent download start
            if let Some(cache_path) = get_cache_path(&url, &handle) {
                let _ = std::fs::write(&cache_path, &stdout_data);
            }

            Ok(stdout_data)
        } else {
            Err(format!("Analysis failed: {}", stderr_data))
        }
    } else {
        Err("Analysis aborted by user request".to_string())
    }
}

#[tauri::command]
async fn download_single_item(
    url: String,
    video_title: String,
    format_id: String,
    custom_dir: String,
    playlist_folder: Option<String>,
    is_audio_only: bool,
    slot_id: usize,
    fragment_concurrency: usize,
    speed_limit: String,
    cookies_source: String,
    cookies_browser: String,
    cookies_file_path: String,
    task_id: String,      // DevOps context parameter mapping
    item_index: usize,    // DevOps context parameter mapping
    total_items: usize,
    state: State<'_, DownloadState>,
    handle: AppHandle,
) -> Result<(), String> {
    let (binary_path, ffmpeg_workspace_dir) = prepare_binaries(&handle)?;

    let base_dir = if custom_dir.is_empty() {
        handle.path().download_dir()
            .map_err(|e| format!("Could not resolve user default download location: {}", e))?
    } else {
        std::path::PathBuf::from(custom_dir)
    };

    let target_dir = match playlist_folder {
        Some(ref folder) if !folder.is_empty() => base_dir.join(folder),
        _ => base_dir,
    };

    if !target_dir.exists() {
        let _ = std::fs::create_dir_all(&target_dir);
    }

    // Prepare hidden temp folder context to store chunks/part files during acquisition
    let temp_dir = target_dir.join(".bolt_tmp");
    if !temp_dir.exists() {
        let _ = std::fs::create_dir_all(&temp_dir);
    }
    
    // Explicitly hide on Windows platform so directories remain 100% clean
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("attrib");
        cmd.args(&["+h", temp_dir.to_str().unwrap_or("")]);

        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);

        let _ = cmd.status();
    }

    let temp_dir_str = temp_dir.to_str().ok_or("Invalid temp directory environment context")?;
    let temp_paths_arg = format!("temp:{}", temp_dir_str);

    // Strict dynamic file naming to prevent format overwriting by appending resolution/audio bitrate details to title
    let ext = if is_audio_only { "mp3" } else { "%(ext)s" };

    let is_playlist = playlist_folder.as_ref().map(|f| !f.is_empty()).unwrap_or(false);
    let name_prefix = if is_playlist {
        if total_items >= 100 {
            format!("{:03}-", item_index + 1)
        } else {
            format!("{:02}-", item_index + 1)
        }
    } else {
        "".to_string()
    };
    
    let output_template = if is_audio_only {
        target_dir.join(format!("{}%(title)s [%(abr)skbps].{}", name_prefix, ext))
    } else {
        target_dir.join(format!("{}%(title)s [%(height)sp].{}", name_prefix, ext))
    };
    
    let output_str = output_template.to_str().ok_or("Invalid output path context")?;

    let format_arg = if is_audio_only {
        if format_id == "128" {
            "bestaudio[abr<=128]/bestaudio".to_string()
        } else {
            "bestaudio/best".to_string()
        }
    } else {
        match format_id.as_str() {
            "1080" => "bestvideo[height<=1080]+bestaudio/best".to_string(),
            "720" => "bestvideo[height<=720]+bestaudio/best".to_string(),
            "480" => "bestvideo[height<=480]+bestaudio/best".to_string(),
            "360" => "bestvideo[height<=360]+bestaudio/best".to_string(),
            _ => format!("{}+bestaudio/best", format_id)
        }
    };

    let cache_path = get_cache_path(&url, &handle);
    let mut cache_exists = false;
    if let Some(ref path) = cache_path {
        if path.exists() {
            if let Ok(metadata) = std::fs::metadata(path) {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(elapsed) = modified.elapsed() {
                        // If cache is less than 5 hours (18000 seconds) old, use it
                        if elapsed.as_secs() < 18000 {
                            cache_exists = true;
                        } else {
                            let _ = std::fs::remove_file(path);
                        }
                    }
                }
            }
        }
    }

    let concurrent_fragments_str = fragment_concurrency.to_string();

    let mut process_args = vec![
        "-f", &format_arg,
        "--ffmpeg-location", ffmpeg_workspace_dir.to_str().unwrap_or(""),
        "-o", output_str,
        "--newline",
        "--concurrent-fragments", &concurrent_fragments_str,
        "--paths", &temp_paths_arg, // Write intermediate files into hidden .bolt_tmp directory
        "--no-warnings",
        "--no-check-certificate",
        "-4",
    ];

    if is_audio_only {
        process_args.push("--extract-audio");
        process_args.push("--audio-format");
        process_args.push("mp3");
        process_args.push("--audio-quality");
        process_args.push("0");
        process_args.push("--no-keep-video"); 
    } else {
        process_args.push("--merge-output-format");
        process_args.push("mp4");
    }

    if !speed_limit.is_empty() && speed_limit != "No limit" {
        process_args.push("--limit-rate");
        process_args.push(&speed_limit);
    }

    // Dynamic Inject Authentication Bypass Parameters
    if cookies_source == "browser" && !cookies_browser.is_empty() {
        process_args.push("--cookies-from-browser");
        process_args.push(&cookies_browser);
    } else if cookies_source == "file" && !cookies_file_path.is_empty() {
        process_args.push("--cookies");
        process_args.push(&cookies_file_path);
    }

    process_args.push("--no-playlist");

    let cache_path_str;
    if cache_exists {
        if let Some(ref path) = cache_path {
            cache_path_str = path.to_string_lossy().to_string();
            process_args.push("--load-info-json");
            process_args.push(&cache_path_str);
        } else {
            process_args.push(&url);
        }
    } else {
        process_args.push(&url);
    }

    let mut cmd = Command::new(&binary_path);
    cmd.args(&process_args)
        .env("PATH", get_augmented_path()) 
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn native engine: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to link stdout channel")?;
    let stderr = child.stderr.take().ok_or("Failed to link stderr channel")?;

    {
        if let Ok(mut guard) = state.active_slots.lock() {
            guard.insert(slot_id, ActiveDownload {
                child,
                task_id: task_id.clone(),
                item_index,
            });
        }
    }

    let handle_stderr = handle.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            let _ = handle_stderr.emit("download-log", DownloadLog {
                slot: slot_id,
                line: format!("[Engine Signal] {}", line),
            });
        }
    });

    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle_stdout = handle.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let _ = handle_stdout.emit("download-log", DownloadLog {
                slot: slot_id,
                line,
            });
        }
        let _ = tx.send(());
    });

    let _ = rx.await;

    let child_process = {
        if let Ok(mut guard) = state.active_slots.lock() {
            guard.remove(&slot_id).map(|download| download.child)
        } else {
            None
        }
    };

    let sanitized_title: String = video_title
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();

    let res = if let Some(mut child) = child_process {
        let status = tokio::task::spawn_blocking(move || child.wait())
            .await
            .map_err(|e| format!("Wait task join failure: {}", e))?
            .map_err(|e| format!("Process termination failure: {}", e))?;
        if status.success() {
            Ok(())
        } else {
            Err("Native downloader process reported non-zero error".to_string())
        }
    } else {
        Err("Process aborted by slot controller".to_string())
    };

    // Clean up temporary files and empty temp folder
    cleanup_temp_files(&temp_dir, &sanitized_title);

    res
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DownloadState::default()) 
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init()) 
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            analyze_video, 
            download_single_item,
            resolve_unique_playlist_dir,
            get_default_download_directory,
            select_download_directory,
            select_cookies_file,
            open_folder,
            cancel_slot,
            cancel_all,
            cancel_task, // Registered DevOps cancellation endpoint
            abort_analysis
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}