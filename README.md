# ⚡ Bolt YouTube Downloader (v1.0.0)

A high-performance, multi-threaded parallel video and audio downloader built with **Tauri**, **React (Vite)**, and **Rust**. Bolt is designed to bypass standard video extraction delays and deliver maximum download speeds through concurrent fragment segment acquisition.

---

## 🚀 Key Features

* **Instant Download Initiation**: Features a local metadata cache bypass (`--load-info-json`) that eliminates redundant webpage lookups and Deno challenge pings, initiating downloads in under 4 seconds.
* **High-Speed Parallel Downloader**: Leverages multi-threaded segment acquisition with customizable fragment concurrency to saturate your network bandwidth.
* **Auto-Cleanup Routine**: Automatically prunes and deletes the hidden `.bolt_tmp` directory and partial/cancellation file fragments (`.part`, `.part-Frag*`) on download completion or termination.
* **Comprehensive Playlist Support**: Extracts and lists flat-playlist entries. Playlist downloads are automatically formatted with zero-padded order indexes (e.g., `01-`, `001-`) to preserve sorting.
* **Suppressed Console Subsystem**: Packaged purely as a Windows GUI application, guaranteeing that no command prompt/terminal window opens on startup.
* **Authentication Bypass**: Supports importing cookie files or decrypting active session cookies from browsers (Chrome, Edge, Firefox, etc.) to download age-restricted or private videos.
* **Modern dark UI**: Built with a premium, responsive HSL-colorized dashboard, parallel queue monitor, and sidebar task scheduler.

---

## 🛠️ Architecture & Technology Stack

* **Frontend**: React (Vite), Vanilla CSS (tailored HSL palettes, smooth micro-animations).
* **Backend**: Rust (Tauri v2), running child processes with `CREATE_NO_WINDOW` and piped streams.
* **Download Engine**: Packaged with a custom-obfuscated `yt-dlp` (`core_module.dll`) and `ffmpeg` (`codec_module.dll`) binaries, which are unpacked dynamically and run inside a hidden local AppData cache folder (`%LOCALAPPDATA%/com.bolt.downloader/`).

---

## 💻 Local Development Setup

### Prerequisites
Make sure you have the following installed on your system:
* **Node.js** (v20+ recommended)
* **Rust** (Cargo toolchain)
* **Deno** (as the default JavaScript challenge-solving runtime for `yt-dlp`)

### Getting Started

1. **Clone the repository**:
   ```bash
   git clone https://github.com/mohsinkhandevs/bolt-youtube-downloader.git
   cd bolt-youtube-downloader
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run in Development Mode**:
   ```bash
   npm run tauri dev
   ```

4. **Build Production Installers**:
   ```bash
   npm run tauri build
   ```

---

## 📦 Cloud Releases & Cross-Platform Compilation

This repository includes a pre-configured **GitHub Actions CI/CD pipeline** located at `.github/workflows/release.yml`. 

Since you cannot compile macOS or Linux binaries directly on a Windows machine, the GitHub Actions cloud pipeline does this for you automatically.

### How to trigger a cloud release:
1. Commit your changes and push them to your repository on GitHub.
2. Tag a new release version starting with `v` (e.g., `v1.0.0`) and push it:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
3. GitHub Actions will spin up Windows, macOS, and Linux virtual machines in the cloud, build the project, and automatically publish a draft release under your repository's **Releases** tab containing:
   * **Windows**: `.msi` and `.exe` installers.
   * **macOS**: `.dmg` (universal disk image) and `.app` binaries.
   * **Linux**: `.deb` (Debian/Ubuntu) and `.AppImage` packages.

---

## 🔒 Security & Privacy

* **Local Cache**: All temporary cache files, partial segments, and unpacked engine DLLs are kept entirely inside the secure user application directory (`%LOCALAPPDATA%/com.bolt.downloader/`).
* **Open Source**: The download commands bypass telemetry pings (`--no-call-home`) and force secure IPv4 lookups (`-4`) to optimize speed and protect user privacy.

---

## 🌐 Website
Visit the official product page: [boltyt.mohsinkhandevs.com](https://boltyt.mohsinkhandevs.com)
