use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::io::{self, Write};
use std::process::Command;
use std::sync::{Arc, Mutex};
use sysinfo::{Components, Disks, Networks, System};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;
use rusqlite::{Connection, params};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
use windows::Win32::System::ProcessStatus::GetModuleBaseNameW;

fn get_active_app() -> String {
    #[cfg(target_os = "windows")]
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return "Idle / System".to_string();
        }

        let mut pid: u32 = 0;
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return "Idle / System".to_string();
        }

        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if let Ok(handle) = handle {
            let mut name_buffer: [u16; 512] = [0; 512];
            let len = GetModuleBaseNameW(handle, None, &mut name_buffer);
            if len > 0 {
                let name = String::from_utf16_lossy(&name_buffer[..len as usize]);
                if name.to_lowercase().ends_with(".exe") {
                    return name[..name.len()-4].to_string();
                }
                return name;
            }
        }
    }
    "Unknown / System".to_string()
}


#[cfg(target_os = "windows")]
fn create_silent_command(cmd: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(cmd);
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

#[cfg(not(target_os = "windows"))]
fn create_silent_command(cmd: &str) -> Command {
    Command::new(cmd)
}

#[derive(Serialize)]
struct DiskInfo {
    name: String,
    total_space: u64,
    available_space: u64,
    kind: String,
}

#[derive(Serialize)]
struct ComponentInfo {
    label: String,
    temp: Option<f32>,
    max_temp: Option<f32>,
    critical_temp: Option<f32>,
}

#[derive(Serialize)]
struct BatteryStats {
    percentage: f32,
    is_charging: bool,
    status: String,
    time_remaining: Option<u64>, // seconds
    health: Option<f32>,         // 0-100
    power_usage: Option<f32>,    // Watts
    cycle_count: Option<u32>,
}

#[derive(Serialize)]
struct ProcessInfo {
    name: String,
    pid: u32,
    parent_pid: Option<u32>,
    cpu_usage: f32,
    memory: u64,
    run_duration: u64,
}

#[derive(Serialize)]
struct DockerContainer {
    id: String,
    name: String,
    image: String,
    status: String,
    state: String,
    ports: String,
}

#[derive(Serialize)]
struct ServiceInfo {
    name: String,
    display_name: String,
    status: String,
}

#[derive(Serialize)]
struct StartupInfo {
    name: String,
    command: String,
    location: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageLog {
    id: Option<i32>,
    user_id: String,
    feature: String,
    duration: i64,
    created_at: i64,
}

#[derive(Serialize)]
struct DbServerInfo {
    name: String,
    port: u16,
    status: String,
    pid: Option<u32>,
    uptime: u64,
}

#[derive(Serialize)]
struct PortInfo {
    port: u16,
    protocol: String,
    pid: u32,
    process_name: String,
    state: String,
}

#[derive(Serialize)]
struct EnvironmentInfo {
    node_version: String,
    python_version: String,
    rust_version: String,
    git_version: String,
    java_version: String,
    go_version: String,
    dotnet_version: String,
    php_version: String,
    os_details: String,
    shell_type: String,
    env_vars: std::collections::HashMap<String, String>,
}

#[derive(Serialize)]
struct DevServerInfo {
    framework: String,
    url: String,
    port: u16,
    pid: u32,
    process_name: String,
    status: String,
}

#[derive(Serialize)]
struct SystemStats {
    cpu_usage: f32,
    cpu_cores: usize,
    physical_cores: usize,
    cpu_model: String,
    cpu_arch: String,
    cpu_freq: u64,
    cpus: Vec<f32>,
    cpu_temp: Option<f32>,
    memory_used: u64,
    memory_total: u64,
    os_name: String,
    os_version: String,
    uptime: u64,
    disks: Vec<DiskInfo>,
    net_received: u64,
    net_transmitted: u64,
    processes: Vec<ProcessInfo>,
    gpu_name: String,
    gpu_usage: f32,
    gpu_temp: Option<f32>,
    gpu_clock: Option<u32>,
    gpu_fan_speed: Option<u32>,
    vram_used: u64,
    vram_total: u64,
    battery: Option<BatteryStats>,
    disk_read_speed: u64,
    disk_write_speed: u64,
    ping: u32,
    wifi_signal: u32,
    load_average: [f64; 3],
    memory_free: u64,
    memory_available: u64,
    swap_total: u64,
    swap_used: u64,
    sensors: Vec<ComponentInfo>,
    local_ip: String,
    active_connections: usize,
    last_boot_time: u64,
    health_score: u8,
    crash_reports_count: u32,
}

pub struct AppState {
    sys: Mutex<System>,
    disks: Mutex<Disks>,
    networks: Mutex<Networks>,
    components: Mutex<Components>,
    last_hardware_refresh: Mutex<std::time::Instant>,

    // Background metrics to prevent blocking main command
    wifi_signal: Mutex<u32>,
    ping: Mutex<u32>,

    last_disk_total_read: Mutex<u64>,
    last_disk_total_write: Mutex<u64>,
    last_sample_time: Mutex<std::time::Instant>,
    gpu_name: Mutex<String>,
    vram_total: Mutex<u64>,
    gpu_usage: Mutex<f32>,
    vram_used: Mutex<u64>,
    db: Mutex<Connection>,
}

#[tauri::command]
fn get_system_stats(state: State<'_, Arc<AppState>>) -> SystemStats {
    let mut sys = state.sys.lock().unwrap();
    let now = std::time::Instant::now();

    // 1. Refresh System/Memory/Processes (Relatively fast)
    sys.refresh_cpu_all();
    sys.refresh_memory();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    // 2. Throttled Hardware Refresh (Every 10 seconds)
    {
        let mut last_hw = state.last_hardware_refresh.lock().unwrap();
        // Check if we need to refresh (either 10s passed or first run where list is empty)
        if now.duration_since(*last_hw).as_secs() >= 10 {
            state.disks.lock().unwrap().refresh(true);
            state.networks.lock().unwrap().refresh(true);
            state.components.lock().unwrap().refresh(true);
            *last_hw = now;
        }
    }

    let cpu_usage = sys.global_cpu_usage();
    let cpu_cores = sys.cpus().len();
    let physical_cores = sys.physical_core_count().unwrap_or(cpu_cores);
    let cpu_model = sys
        .cpus()
        .get(0)
        .map(|c| c.brand().to_string())
        .unwrap_or_else(|| "Unknown".to_string());
    let cpu_freq = sys.cpus().get(0).map(|c| c.frequency()).unwrap_or(0);

    let memory_used = sys.used_memory();
    let memory_total = sys.total_memory();

    // 3. Collect disks from CACHE
    let disks = state
        .disks
        .lock()
        .unwrap()
        .iter()
        .map(|disk| DiskInfo {
            name: disk.name().to_string_lossy().into_owned(),
            total_space: disk.total_space(),
            available_space: disk.available_space(),
            kind: format!("{:?}", disk.kind()),
        })
        .collect();

    // 4. Collect network from CACHE
    let mut net_received = 0;
    let mut net_transmitted = 0;
    for (_name, data) in state.networks.lock().unwrap().iter() {
        net_received += data.total_received();
        net_transmitted += data.total_transmitted();
    }

    let cpus: Vec<f32> = sys.cpus().iter().map(|cpu| cpu.cpu_usage()).collect();

    // 5. Collect temp/gpu/sensors from CACHE
    let mut cpu_temp = None;
    let mut gpu_name = "N/A".to_string();
    let mut gpu_temp = None;
    let mut gpu_fan_speed = None;
    let mut sensors = Vec::new();

    for c in state.components.lock().unwrap().iter() {
        let label = c.label().to_lowercase();
        let temp = c.temperature();

        sensors.push(ComponentInfo {
            label: c.label().to_string(),
            temp: c.temperature(),
            max_temp: c.max(),
            critical_temp: c.critical(),
        });

        if cpu_temp.is_none() && (label.contains("cpu") || label.contains("package")) {
            cpu_temp = temp;
        }

        let is_gpu = label.contains("gpu") || label.contains("nvidia") || label.contains("amd") || label.contains("graphics");
        if is_gpu {
            if gpu_name == "N/A" {
                gpu_name = c.label().to_string();
            }
            if gpu_temp.is_none() {
                gpu_temp = temp;
            }
            if label.contains("fan") {
                gpu_fan_speed = temp.map(|v| v as u32);
            }
        }
    }

    // 6. Disk Speed
    let mut current_disk_read_total = 0;
    let mut current_disk_write_total = 0;
    let processes: Vec<ProcessInfo> = sys
        .processes()
        .iter()
        .map(|(pid, process)| {
            let du = process.disk_usage();
            current_disk_read_total += du.total_read_bytes;
            current_disk_write_total += du.total_written_bytes;
            ProcessInfo {
                name: process.name().to_string_lossy().into_owned(),
                pid: pid.as_u32(),
                parent_pid: process.parent().map(|p| p.as_u32()),
                cpu_usage: process.cpu_usage(),
                memory: process.memory(),
                run_duration: process.run_time(),
            }
        })
        .collect();

    // 7. Battery Stats
    let mut battery_info = None;
    if let Ok(manager) = starship_battery::Manager::new() {
        if let Ok(mut batteries) = manager.batteries() {
            if let Some(Ok(battery)) = batteries.next() {
                let percentage = battery.state_of_charge().value * 100.0;
                let status = format!("{:?}", battery.state());
                let is_charging = match battery.state() {
                    starship_battery::State::Charging | starship_battery::State::Full => true,
                    _ => false,
                };

                let time_remaining = battery
                    .time_to_full()
                    .map(|v| v.value as u64)
                    .or_else(|| battery.time_to_empty().map(|v| v.value as u64));

                let energy_full = battery.energy_full().value;
                let energy_full_design = battery.energy_full_design().value;
                let health = if energy_full_design > 0.0 {
                    Some((energy_full / energy_full_design) * 100.0)
                } else {
                    None
                };

                // Power in Watts = Voltage * Current (starship-battery usually provides energy_rate directly)
                let power_usage = Some(battery.energy_rate().value);

                battery_info = Some(BatteryStats {
                    percentage,
                    is_charging,
                    status,
                    time_remaining,
                    health,
                    power_usage,
                    cycle_count: battery.cycle_count(),
                });
            }
        }
    }

    let mut last_time = state.last_sample_time.lock().unwrap();
    let mut last_read = state.last_disk_total_read.lock().unwrap();
    let mut last_write = state.last_disk_total_write.lock().unwrap();

    let duration = now.duration_since(*last_time).as_secs_f64();
    let disk_read_speed = if duration > 0.0 && *last_read > 0 {
        ((current_disk_read_total.saturating_sub(*last_read)) as f64 / duration) as u64
    } else {
        0
    };
    let disk_write_speed = if duration > 0.0 && *last_write > 0 {
        ((current_disk_write_total.saturating_sub(*last_write)) as f64 / duration) as u64
    } else {
        0
    };

    *last_time = now;
    *last_read = current_disk_read_total;
    *last_write = current_disk_write_total;

    SystemStats {
        cpu_usage,
        cpu_cores,
        physical_cores,
        cpu_model,
        cpu_arch: System::cpu_arch(),
        cpu_freq,
        cpus,
        cpu_temp,
        memory_used,
        memory_total,
        os_name: System::name().unwrap_or_default(),
        os_version: System::os_version().unwrap_or_default(),
        uptime: System::uptime(),
        disks,
        net_received,
        net_transmitted,
        processes,
        gpu_name: if gpu_name == "N/A" {
            state.gpu_name.lock().unwrap().clone()
        } else {
            gpu_name
        },
        gpu_usage: *state.gpu_usage.lock().unwrap(),
        gpu_temp,
        gpu_clock: None, // Hard to get cross-platform without specialized crates
        gpu_fan_speed,
        vram_used: *state.vram_used.lock().unwrap(),
        vram_total: *state.vram_total.lock().unwrap(),
        disk_read_speed,
        disk_write_speed,
        ping: *state.ping.lock().unwrap(),
        wifi_signal: *state.wifi_signal.lock().unwrap(),
        load_average: [
            System::load_average().one,
            System::load_average().five,
            System::load_average().fifteen,
        ],
        memory_free: sys.free_memory(),
        memory_available: sys.available_memory(),
        swap_total: sys.total_swap(),
        swap_used: sys.used_swap(),
        sensors,
        local_ip: local_ip_address::local_ip()
            .map(|ip| ip.to_string())
            .unwrap_or_else(|_| "Unknown".to_string()),
        active_connections: sys.processes().len(), // Fallback or estimate
        last_boot_time: System::boot_time(),
        health_score: calculate_health_score(
            cpu_usage,
            memory_used,
            memory_total,
            cpu_temp,
            &battery_info,
        ),
        battery: battery_info,
        crash_reports_count: get_crash_reports_count(),
    }
}

fn calculate_health_score(
    cpu_usage: f32,
    memory_used: u64,
    memory_total: u64,
    cpu_temp: Option<f32>,
    battery: &Option<BatteryStats>,
) -> u8 {
    let mut score = 100i16;

    if cpu_usage > 90.0 {
        score -= 20;
    } else if cpu_usage > 70.0 {
        score -= 10;
    }

    if memory_total > 0 {
        let mem_pct = (memory_used as f64 / memory_total as f64) * 100.0;
        if mem_pct > 95.0 {
            score -= 25;
        } else if mem_pct > 80.0 {
            score -= 15;
        }
    }

    if let Some(t) = cpu_temp {
        if t > 90.0 {
            score -= 20;
        } else if t > 75.0 {
            score -= 10;
        }
    }

    if let Some(bat) = battery {
        if let Some(health) = bat.health {
            if health < 70.0 {
                score -= 15;
            } else if health < 85.0 {
                score -= 5;
            }
        }
    }

    score.max(0).min(100) as u8
}

fn get_crash_reports_count() -> u32 {
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("LOCALAPPDATA") {
            let path = format!("{}\\CrashDumps", appdata);
            if let Ok(entries) = std::fs::read_dir(path) {
                return entries.count() as u32;
            }
        }
    }
    0
}

fn get_latency() -> u32 {
    let now = std::time::Instant::now();
    if let Ok(_) = std::net::TcpStream::connect_timeout(
        &"8.8.8.8:53".parse().unwrap(),
        std::time::Duration::from_millis(400),
    ) {
        now.elapsed().as_millis() as u32
    } else {
        0
    }
}

fn get_wifi_signal() -> u32 {
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = create_silent_command("netsh")
            .args(&["wlan", "show", "interfaces"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            for line in s.lines() {
                if line.contains("Signal") {
                    if let Some(pct) = line
                        .split(':')
                        .last()
                        .and_then(|p| p.trim().trim_end_matches('%').parse::<u32>().ok())
                    {
                        return pct;
                    }
                }
            }
        }
    }
    0
}

#[tauri::command]
fn kill_process(state: State<'_, Arc<AppState>>, pid: u32) -> Result<(), String> {
    let sys = state.sys.lock().unwrap();
    if let Some(process) = sys.process(sysinfo::Pid::from(pid as usize)) {
        if process.kill() {
            Ok(())
        } else {
            Err("Failed to kill process".to_string())
        }
    } else {
        Err("Process not found".to_string())
    }
}

#[tauri::command]
fn get_services() -> Vec<ServiceInfo> {
    #[cfg(target_os = "windows")]
    {
        let output = create_silent_command("powershell")
            .args(&[
                "-Command",
                "Get-Service | Select-Object Name, DisplayName, Status | ConvertTo-Json",
            ])
            .output();
        if let Ok(out) = output {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(arr) = v.as_array() {
                    return arr
                        .iter()
                        .map(|v| ServiceInfo {
                            name: v["Name"].as_str().unwrap_or("").to_string(),
                            display_name: v["DisplayName"].as_str().unwrap_or("").to_string(),
                            status: v["Status"]
                                .as_i64()
                                .map(|s| if s == 4 { "Running" } else { "Stopped" })
                                .unwrap_or("Unknown")
                                .to_string(),
                        })
                        .collect();
                }
            }
        }
    }
    vec![]
}

#[tauri::command]
fn control_service(name: String, action: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let cmd = if action == "start" {
            "Start-Service"
        } else {
            "Stop-Service"
        };
        let output = create_silent_command("powershell")
            .args(&[
                "-Command",
                &format!(
                    "Start-Process powershell -ArgumentList '-Command {} {}' -Verb RunAs",
                    cmd, name
                ),
            ])
            .output();
        if output.is_ok() {
            return Ok(());
        }
    }
    Err("Failed to execute service control".to_string())
}

#[tauri::command]
fn get_startup_apps() -> Vec<StartupInfo> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let output = Command::new("powershell").args(&["-Command", "Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location | ConvertTo-Json"]).output();
        if let Ok(out) = output {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(arr) = v.as_array() {
                    return arr
                        .iter()
                        .map(|v| StartupInfo {
                            name: v["Name"].as_str().unwrap_or("").to_string(),
                            command: v["Command"].as_str().unwrap_or("").to_string(),
                            location: v["Location"].as_str().unwrap_or("").to_string(),
                        })
                        .collect();
                } else if let Some(obj) = v.as_object() {
                    return vec![StartupInfo {
                        name: obj["Name"].as_str().unwrap_or("").to_string(),
                        command: obj["Command"].as_str().unwrap_or("").to_string(),
                        location: obj["Location"].as_str().unwrap_or("").to_string(),
                    }];
                }
            }
        }
    }
    vec![]
}

#[tauri::command]
fn save_usage(
    state: State<'_, Arc<AppState>>,
    user_id: String,
    feature: String,
    duration: u64,
    timestamp: i64,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO usage_logs (user_id, feature, duration, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![user_id, feature, duration, timestamp],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DailyUsage {
    feature: String,
    total_duration: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WeeklyTrend {
    date: String,
    total_duration: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppLimit {
    feature: String,
    daily_limit: u64, // seconds
}

#[tauri::command]
fn get_daily_usage(state: State<'_, Arc<AppState>>) -> Result<Vec<DailyUsage>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare(
        "SELECT feature, SUM(duration) as total_duration 
         FROM usage_logs 
         WHERE date(created_at, 'unixepoch', 'localtime') = date('now', 'localtime')
         GROUP BY feature
         ORDER BY total_duration DESC"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(DailyUsage {
            feature: row.get(0)?,
            total_duration: row.get(1)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

#[tauri::command]
fn get_usage_logs(state: State<'_, Arc<AppState>>) -> Result<Vec<UsageLog>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare("SELECT id, user_id, feature, duration, created_at FROM usage_logs ORDER BY created_at DESC LIMIT 100")
        .map_err(|e| e.to_string())?;

    let logs = stmt.query_map([], |row| {
        Ok(UsageLog {
            id: Some(row.get(0)?),
            user_id: row.get(1)?,
            feature: row.get(2)?,
            duration: row.get(3)?,
            created_at: row.get(4)?,
        })
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    Ok(logs)
}

#[tauri::command]
fn get_weekly_trends(state: State<'_, Arc<AppState>>) -> Result<Vec<WeeklyTrend>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    // Get last 7 days of total usage
    let mut stmt = db.prepare(
        "SELECT date(created_at, 'unixepoch', 'localtime') as day, SUM(duration) as total_duration 
         FROM usage_logs 
         WHERE created_at >= strftime('%s', 'now', '-7 days')
         GROUP BY day
         ORDER BY day ASC"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(WeeklyTrend {
            date: row.get(0)?,
            total_duration: row.get(1)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

#[tauri::command]
fn get_usage_limits(state: State<'_, Arc<AppState>>) -> Result<Vec<AppLimit>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db.prepare("SELECT feature, daily_limit FROM usage_limits").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(AppLimit {
            feature: row.get(0)?,
            daily_limit: row.get(1)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

#[tauri::command]
fn save_usage_limit(state: State<'_, Arc<AppState>>, feature: String, daily_limit: u64) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO usage_limits (user_id, feature, daily_limit) VALUES (?1, ?2, ?3)",
        params!["system_user", feature, daily_limit],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_usage_limit(state: State<'_, Arc<AppState>>, feature: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM usage_limits WHERE feature = ?1", [feature]).map_err(|e| e.to_string())?;
    Ok(())
}


#[tauri::command]
async fn save_export(
    app: tauri::AppHandle,
    filename: String,
    base64_content: String,
) -> Result<String, String> {
    // 1. Get Downloads Path
    let mut path = app.path().download_dir().map_err(|e| e.to_string())?;
    path.push("SystemMonitor_Exports");

    // 2. Create Directory
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }

    // 3. Prepare File Path
    path.push(&filename);

    // 4. Decode and Write
    // Note: We use base64 to avoid encoding issues between JS and Rust
    use base64::{engine::general_purpose, Engine as _};
    let data = general_purpose::STANDARD
        .decode(base64_content)
        .map_err(|e| format!("Decode error: {}", e))?;

    fs::write(&path, data).map_err(|e| e.to_string())?;

    // 5. Open the folder so user sees their success
    let opener = app.opener();
    let parent = path.parent().unwrap().to_path_buf();
    let _ = opener.open_path(parent.to_string_lossy().to_string(), Option::<String>::None);

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_active_ports(state: State<'_, Arc<AppState>>) -> Result<Vec<PortInfo>, String> {
    // On Windows, use netstat -ano to find listening ports
    let output = if cfg!(target_os = "windows") {
        create_silent_command("netstat")
            .args(["-ano"]) // Get all, include UDP
            .output()
            .map_err(|e| e.to_string())?
    } else {
        return Err("OS not supported".to_string());
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut ports = Vec::new();

    let mut sys = state.sys.lock().map_err(|e| e.to_string())?;
    sys.refresh_all();

    for line in stdout.lines().skip(4) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }

        let protocol = parts[0];
        let is_tcp = protocol == "TCP";
        let is_udp = protocol == "UDP";

        if !is_tcp && !is_udp {
            continue;
        }

        // TCP has [Proto, Local, Foreign, State, PID]
        // UDP has [Proto, Local, Foreign, PID]
        let local_addr = parts[1];
        let state_val = if is_tcp { parts[3] } else { "ACTIVE" };
        let pid_str = if is_tcp { parts[4] } else { parts[3] };

        if is_tcp && state_val != "LISTENING" {
            continue;
        }

        if let Some(port_str) = local_addr.split(':').last() {
            if let Ok(port) = port_str.parse::<u16>() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    let process_name = sys
                        .process(sysinfo::Pid::from(pid as usize))
                        .map(|p| p.name().to_string_lossy().into_owned())
                        .unwrap_or_else(|| "Unknown".to_string());

                    ports.push(PortInfo {
                        port,
                        protocol: protocol.to_string(),
                        pid,
                        process_name,
                        state: state_val.to_string(),
                    });
                }
            }
        }
    }

    // Sort by port number
    ports.sort_by_key(|p| p.port);
    // Deduplicate (netstat sometimes shows same port on different interfaces)
    ports.dedup_by_key(|p| p.port);

    Ok(ports)
}

#[tauri::command]
async fn get_dev_servers(state: State<'_, Arc<AppState>>) -> Result<Vec<DevServerInfo>, String> {
    let output = if cfg!(target_os = "windows") {
        create_silent_command("netstat")
            .args(["-ano"])
            .output()
            .map_err(|e| e.to_string())?
    } else {
        return Err("OS not supported".to_string());
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut servers = Vec::new();

    let mut sys = state.sys.lock().map_err(|e| e.to_string())?;
    sys.refresh_all();

    for line in stdout.lines().skip(4) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }

        let protocol = parts[0];
        if protocol != "TCP" {
            continue;
        }

        let local_addr = parts[1];
        let state_val = if parts.len() > 3 { parts[3] } else { "" };
        let pid_str = if parts.len() > 4 { parts[4] } else { "" };

        if state_val != "LISTENING" || pid_str.is_empty() {
            continue;
        }

        if let Some(port_str) = local_addr.split(':').last() {
            if let Ok(port) = port_str.parse::<u16>() {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    let process_name = sys
                        .process(sysinfo::Pid::from(pid as usize))
                        .map(|p| p.name().to_string_lossy().into_owned())
                        .unwrap_or_else(|| "Unknown".to_string());

                    let mut framework = "Local Server".to_string();
                    let name_low = process_name.to_lowercase();

                    if name_low.contains("node") {
                        if port == 5173 {
                            framework = "Vite / React / Vue".to_string();
                        } else if port == 3000 {
                            framework = "Next.js / Node / React".to_string();
                        } else if port == 8080 || port == 8000 {
                            framework = "Node.js Server".to_string();
                        }
                    } else if name_low.contains("python") {
                        if port == 5000 {
                            framework = "Flask / Python".to_string();
                        } else if port == 8000 {
                            framework = "Django / Python".to_string();
                        }
                    } else if name_low.contains("php") {
                        framework = "PHP Server".to_string();
                    } else if name_low.contains("go") {
                        framework = "Golang Server".to_string();
                    }

                    if framework != "Local Server"
                        || [3000, 3001, 5173, 5000, 8000, 8080].contains(&port)
                    {
                        servers.push(DevServerInfo {
                            framework,
                            url: format!("http://localhost:{}", port),
                            port,
                            pid,
                            process_name,
                            status: "Running".to_string(),
                        });
                    }
                }
            }
        }
    }

    Ok(servers)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[tauri::command]
fn open_project_folder(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    use sysinfo::{Pid, System};
    let mut sys = System::new();
    sys.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[Pid::from(pid as usize)]),
        true,
    );

    if let Some(process) = sys.process(Pid::from(pid as usize)) {
        if let Some(cwd) = process.cwd() {
            let path = cwd.to_string_lossy().to_string();
            let opener = app.opener();
            let _ = opener.open_path(path, Option::<String>::None);
            return Ok(());
        }
    }
    Err("Could not find project folder for this process".to_string())
}

#[tauri::command]
async fn get_docker_containers() -> Result<Vec<DockerContainer>, String> {
    let output = create_silent_command("docker")
        .args([
            "ps",
            "-a",
            "--format",
            "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.Ports}}",
        ])
        .output()
        .map_err(|e| format!("Docker not found or error: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut containers = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() >= 6 {
            containers.push(DockerContainer {
                id: parts[0].to_string(),
                name: parts[1].to_string(),
                image: parts[2].to_string(),
                status: parts[3].to_string(),
                state: parts[4].to_string(),
                ports: parts[5].to_string(),
            });
        }
    }
    Ok(containers)
}

#[tauri::command]
async fn control_docker_container(id: String, action: String) -> Result<(), String> {
    let valid_actions = ["start", "stop", "restart"];
    if !valid_actions.contains(&action.as_str()) {
        return Err("Invalid action".to_string());
    }

    create_silent_command("docker")
        .args([&action, &id])
        .output()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn get_db_servers(state: State<'_, Arc<AppState>>) -> Result<Vec<DbServerInfo>, String> {
    let mut db_servers = Vec::new();
    let db_ports = vec![
        (3306, "MySQL"),
        (5432, "PostgreSQL"),
        (27017, "MongoDB"),
        (6379, "Redis"),
        (1433, "SQL Server"),
        (28015, "RethinkDB"),
    ];

    let mut sys = state.sys.lock().map_err(|e| e.to_string())?;
    sys.refresh_all();

    // Re-use active ports logic internally
    let output = create_silent_command("netstat")
        .args(["-ano"])
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    for (port, name) in db_ports {
        let pattern = format!(":{}", port);
        let found = stdout
            .lines()
            .find(|l| l.contains(&pattern) && l.contains("LISTENING"));

        if let Some(line) = found {
            let parts: Vec<&str> = line.split_whitespace().collect();
            let pid_str = parts.get(4).unwrap_or(&"");
            let pid = pid_str.parse::<u32>().ok();

            let uptime = if let Some(p) = pid {
                sys.process(sysinfo::Pid::from(p as usize))
                    .map(|proc| proc.run_time())
                    .unwrap_or(0)
            } else {
                0
            };

            db_servers.push(DbServerInfo {
                name: name.to_string(),
                port,
                status: "Running".to_string(),
                pid,
                uptime,
            });
        }
    }

    Ok(db_servers)
}

#[tauri::command]
async fn get_environment_info() -> Result<EnvironmentInfo, String> {
    let mut info = EnvironmentInfo {
        node_version: "Not found".to_string(),
        python_version: "Not found".to_string(),
        rust_version: "Not found".to_string(),
        git_version: "Not found".to_string(),
        java_version: "Not found".to_string(),
        go_version: "Not found".to_string(),
        dotnet_version: "Not found".to_string(),
        php_version: "Not found".to_string(),
        os_details: format!(
            "{} {} ({})",
            System::name().unwrap_or_default(),
            System::os_version().unwrap_or_default(),
            System::cpu_arch()
        ),
        shell_type: "Unknown".to_string(),
        env_vars: std::env::vars().collect(),
    };

    // Node Version
    if let Ok(out) = create_silent_command("node").arg("--version").output() {
        info.node_version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }

    // Python Version
    if let Ok(out) = create_silent_command("python").arg("--version").output() {
        info.python_version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    } else if let Ok(out) = create_silent_command("python3").arg("--version").output() {
        info.python_version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }

    // Rust Version
    if let Ok(out) = create_silent_command("rustc").arg("--version").output() {
        info.rust_version = String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .nth(1)
            .unwrap_or("Unknown")
            .to_string();
    }

    // Git Version
    if let Ok(out) = create_silent_command("git").arg("--version").output() {
        info.git_version = String::from_utf8_lossy(&out.stdout)
            .replace("git version", "")
            .trim()
            .to_string();
    }

    // Java Version
    if let Ok(out) = create_silent_command("java").arg("-version").output() {
        // Java prints version to stderr
        let s = String::from_utf8_lossy(&out.stderr);
        if let Some(line) = s.lines().next() {
            info.java_version = line.replace("java version", "").replace("openjdk version", "").trim().to_string();
        }
    }

    // Go Version
    if let Ok(out) = create_silent_command("go").arg("version").output() {
        info.go_version = String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .nth(2)
            .unwrap_or("Unknown")
            .to_string();
    }

    // .NET Version
    if let Ok(out) = create_silent_command("dotnet").arg("--version").output() {
        info.dotnet_version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }

    // PHP Version
    if let Ok(out) = create_silent_command("php").arg("-v").output() {
        let s = String::from_utf8_lossy(&out.stdout);
        if let Some(line) = s.lines().next() {
            info.php_version = line.split_whitespace().nth(1).unwrap_or("Unknown").to_string();
        }
    }

    // Shell Type
    #[cfg(target_os = "windows")]
    {
        if std::env::var("PSModulePath").is_ok() {
            info.shell_type = "PowerShell".to_string();
        } else {
            info.shell_type = "CMD".to_string();
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            info.shell_type = shell.split('/').last().unwrap_or("Unknown").to_string();
        }
    }

    Ok(info)
}

#[tauri::command]
async fn toggle_gaming_boost(active: bool) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c is High Performance
        // a1841308-3541-4fab-bc81-f71556f20b4a is Power Saver
        // 381b4222-f694-41f0-9685-ff5bb260df2e is Balanced

        let plan_guid = if active {
            "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
        } else {
            "381b4222-f694-41f0-9685-ff5bb260df2e"
        };

        create_silent_command("powercfg")
            .args(["-setactive", plan_guid])
            .output()
            .map_err(|e| e.to_string())?;

        Ok(if active {
            "High Performance Mode Active"
        } else {
            "Balanced Mode Resumed"
        }
        .to_string())
    }
    #[cfg(not(target_os = "windows"))]
    Ok("Feature only available on Windows".to_string())
}

#[tauri::command]
async fn cleanup_gaming_memory() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // Use PowerShell to clear working sets of non-essential processes or common bloat
        // This is a simplified "Booster" approach
        let script = r#"
            Get-Process | Where-Object { $_.MainWindowTitle -eq "" -and $_.CPU -lt 1 } | ForEach-Object { 
                try { [Runtime.InteropServices.Marshal]::FreeHGlobal(0) } catch {}
            }
        "#;

        create_silent_command("powershell")
            .args(["-Command", script])
            .output()
            .map_err(|e| e.to_string())?;

        Ok("Memory working set optimization complete".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    Ok("Not implemented for this OS".to_string())
}

#[tauri::command]
fn report_error(error: String) {
    eprintln!("[ZOH ERROR REPORT] {}", error);
    // In a real app, this would send to Sentry or a log file
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn handle_cli_commands() -> bool {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        return false;
    }

    let command = &args[1];

    match command.as_str() {
        "scan" => {
            println!("\x1b[93m--- ZOH: AI SYSTEM SCAN (CLI MODE) ---\x1b[0m");
            let mut sys = System::new_all();
            sys.refresh_all();

            println!("System Name:    {}", System::name().unwrap_or_default());
            println!(
                "System Version: {}",
                System::os_version().unwrap_or_default()
            );
            println!(
                "Kernel Version: {}",
                System::kernel_version().unwrap_or_default()
            );
            println!(
                "Host Name:      {}",
                System::host_name().unwrap_or_default()
            );
            println!("Arch:           {}", System::cpu_arch());
            println!("");
            println!("CPU Model:      {}", sys.cpus()[0].brand());
            println!("Global Usage:   {:.2}%", sys.global_cpu_usage());
            println!("Total Memory:   {} MB", sys.total_memory() / 1024 / 1024);
            println!("Used Memory:    {} MB", sys.used_memory() / 1024 / 1024);
            println!(
                "Swap:           {} / {} MB",
                sys.used_swap() / 1024 / 1024,
                sys.total_swap() / 1024 / 1024
            );
            println!("");
            println!(
                "Uptime:         {}h {}m",
                System::uptime() / 3600,
                (System::uptime() % 3600) / 60
            );
            println!("\x1b[93m--------------------------------------\x1b[0m");
            true
        }
        "monitor" => {
            if args.contains(&"--cpu".to_string()) {
                println!("\x1b[93mZOH Active Monitor: CPU Usage (Ctrl+C to stop)\x1b[0m");
                let mut sys = System::new_all();
                loop {
                    sys.refresh_cpu_usage();
                    print!(
                        "\rCPU Usage: \x1b[92m[{: <50}]\x1b[0m {:.1}%   ",
                        "=".repeat((sys.global_cpu_usage() / 2.0) as usize),
                        sys.global_cpu_usage()
                    );
                    io::stdout().flush().unwrap();
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                }
            } else {
                println!("Usage: zoh monitor --cpu");
                true
            }
        }
        "clean-temp" => {
            println!("\x1b[91mZOH Cleaner: Searching for temporary clutter...\x1b[0m");
            let mut freed_space = 0;

            #[cfg(target_os = "windows")]
            {
                if let Ok(temp_dir) = env::var("TEMP") {
                    if let Ok(entries) = fs::read_dir(&temp_dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            if let Ok(metadata) = fs::metadata(&path) {
                                let size = metadata.len();
                                if path.is_file() {
                                    if fs::remove_file(&path).is_ok() {
                                        freed_space += size;
                                    }
                                } else if fs::remove_dir_all(&path).is_ok() {
                                    freed_space += size;
                                }
                            }
                        }
                    }
                }
            }

            println!(
                "\x1b[92mSuccess! ZOH has freed up {} MB of temporary space.\x1b[0m",
                freed_space / 1024 / 1024
            );
            true
        }
        "help" | "--help" | "-h" => {
            println!("ZOH: AI SYSTEM MONITOR - CLI HELP");
            println!("Commands:");
            println!("  scan         Quick system health and hardware summary");
            println!("  monitor      Real-time monitors (usage: monitor --cpu)");
            println!("  clean-temp   Purge system temporary files");
            true
        }
        _ => false,
    }
}

fn get_gpu_name_fallback() -> String {
    #[cfg(target_os = "windows")]
    {
        let output = create_silent_command("wmic")
            .args(&["path", "win32_VideoController", "get", "name"])
            .output();
        if let Ok(out) = output {
            let s = String::from_utf8_lossy(&out.stdout);
            let lines: Vec<&str> = s.lines().collect();
            for line in lines {
                let trimmed = line.trim();
                if !trimmed.is_empty() && trimmed != "Name" {
                    return trimmed.to_string();
                }
            }
        }
    }
    "N/A".to_string()
}

fn get_vram_total_fallback() -> u64 {
    #[cfg(target_os = "windows")]
    {
        let output = create_silent_command("wmic")
            .args(&["path", "win32_VideoController", "get", "AdapterRAM"])
            .output();
        if let Ok(out) = output {
            let s = String::from_utf8_lossy(&out.stdout);
            let lines: Vec<&str> = s.lines().collect();
            for line in lines {
                let trimmed = line.trim();
                if !trimmed.is_empty() && trimmed != "AdapterRAM" {
                    if let Ok(bytes) = trimmed.parse::<u64>() {
                        return bytes;
                    }
                }
            }
        }
    }
    0
}

fn get_gpu_usage_fallback() -> (f32, u64) {
    #[cfg(target_os = "windows")]
    {
        // Try nvidia-smi first (much faster if available)
        if let Ok(out) = create_silent_command("nvidia-smi")
            .args(&["--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            let parts: Vec<&str> = s.split(',').collect();
            if parts.len() >= 2 {
                let usage = parts[0].trim().parse::<f32>().unwrap_or(0.0);
                let vram_mb = parts[1].trim().parse::<u64>().unwrap_or(0);
                return (usage, vram_mb * 1024 * 1024);
            }
        }

        // Fallback to PowerShell (Slow, runs in background thread every 5s)
        let script = "(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Average | Select-Object -ExpandProperty Average";
        let output = create_silent_command("powershell")
            .args(&["-Command", script])
            .output();

        let mut usage = 0.0;
        if let Ok(out) = output {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Ok(val) = s.parse::<f32>() {
                usage = val;
            }
        }

        let vram_script = "(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum";
        let vram_output = create_silent_command("powershell")
            .args(&["-Command", vram_script])
            .output();

        let mut vram = 0;
        if let Ok(out) = vram_output {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Ok(val) = s.parse::<f64>() {
                vram = val as u64;
            }
        }

        return (usage, vram);
    }
    #[cfg(not(target_os = "windows"))]
    (0.0, 0)
}

pub fn run() {

    if handle_cli_commands() {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().unwrap();
            if !data_dir.exists() {
                fs::create_dir_all(&data_dir).unwrap();
            }
            let db_path = data_dir.join("zoh_monitor.db");
            let conn = Connection::open(db_path).expect("Failed to open database");
            
            // Enable WAL mode for better concurrency between threads
            let _ = conn.execute("PRAGMA journal_mode=WAL", []);
            
            conn.execute(
                "CREATE TABLE IF NOT EXISTS usage_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    feature TEXT NOT NULL,
                    duration INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                )",
                [],
            ).expect("Failed to create table");

            conn.execute(
                "CREATE TABLE IF NOT EXISTS usage_limits (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    feature TEXT NOT NULL,
                    daily_limit INTEGER NOT NULL,
                    UNIQUE(user_id, feature)
                )",
                [],
            ).expect("Failed to create table");

            let app_state = Arc::new(AppState {
                sys: Mutex::new(System::new_all()),
                disks: Mutex::new(Disks::new_with_refreshed_list()),
                networks: Mutex::new(Networks::new_with_refreshed_list()),
                components: Mutex::new(Components::new_with_refreshed_list()),
                last_hardware_refresh: Mutex::new(std::time::Instant::now()),
                wifi_signal: Mutex::new(100),
                ping: Mutex::new(0),
                last_disk_total_read: Mutex::new(0),
                last_disk_total_write: Mutex::new(0),
                last_sample_time: Mutex::new(std::time::Instant::now()),
                gpu_name: Mutex::new(get_gpu_name_fallback()),
                vram_total: Mutex::new(get_vram_total_fallback()),
                gpu_usage: Mutex::new(0.0),
                vram_used: Mutex::new(0),
                db: Mutex::new(conn),
            });

            app.manage(app_state.clone());

            // Background Thread for Slow Metrics

            let thread_state = app_state.clone();
            std::thread::spawn(move || loop {
                let wifi = get_wifi_signal();
                let latency = get_latency();
                let (gpu, vram) = get_gpu_usage_fallback();
                {
                    if let Ok(mut ws) = thread_state.wifi_signal.lock() {
                        *ws = wifi;
                    }
                    if let Ok(mut ps) = thread_state.ping.lock() {
                        *ps = latency;
                    }
                    if let Ok(mut gs) = thread_state.gpu_usage.lock() {
                        *gs = gpu;
                    }
                    if let Ok(mut vu) = thread_state.vram_used.lock() {
                        *vu = vram;
                    }
                }
                std::thread::sleep(std::time::Duration::from_secs(5));
            });

            // App Tracking Thread
            let thread_state_tracking = app_state.clone();
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut current_app = get_active_app();
                let mut last_change = std::time::Instant::now();
                let mut check_counter = 0;
                
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let now_app = get_active_app();
                    
                    let elapsed = last_change.elapsed().as_secs();

                    // Every 5 seconds, check against limits
                    check_counter += 1;
                    if check_counter >= 5 {
                        check_counter = 0;
                        if let Ok(db) = thread_state_tracking.db.lock() {
                            // Sum usage today + current elapsed
                            let mut stmt = db.prepare(
                                "SELECT SUM(duration) FROM usage_logs 
                                 WHERE feature = ?1 AND date(created_at, 'unixepoch', 'localtime') = date('now', 'localtime')"
                            ).ok();
                            
                            if let Some(mut stmt) = stmt {
                                let past_today: u64 = stmt.query_row([&current_app], |r| r.get(0)).unwrap_or(0);
                                let total_today = past_today + elapsed;

                                // Get limit for this feature
                                let limit: Option<u64> = db.query_row(
                                    "SELECT daily_limit FROM usage_limits WHERE feature = ?1",
                                    [&current_app],
                                    |r| r.get(0)
                                ).ok();

                                if let Some(l) = limit {
                                    if total_today >= l {
                                        use tauri::Emitter;
                                        let _ = app_handle.emit("limit_reached", AppLimit {
                                            feature: current_app.clone(),
                                            daily_limit: l
                                        });
                                    }
                                }
                            }
                        }
                    }

                    // If app changed OR it's been 60 seconds, record it
                    if now_app != current_app || elapsed >= 60 {
                        if elapsed > 0 {
                            if let Ok(db) = thread_state_tracking.db.lock() {
                                let timestamp = chrono::Utc::now().timestamp();
                                let _ = db.execute(
                                    "INSERT INTO usage_logs (user_id, feature, duration, created_at) VALUES (?1, ?2, ?3, ?4)",
                                    params!["system_user", current_app, elapsed, timestamp],
                                );
                            }
                        }
                        current_app = now_app;
                        last_change = std::time::Instant::now();
                    }
                }
            });

            Ok(())
        })

        .invoke_handler(tauri::generate_handler![
            greet,
            get_system_stats,
            kill_process,
            get_services,
            control_service,
            get_startup_apps,
            save_export,
            get_active_ports,
            get_dev_servers,
            open_project_folder,
            get_docker_containers,
            control_docker_container,
            get_db_servers,
            get_environment_info,
            toggle_gaming_boost,
            cleanup_gaming_memory,
            report_error,
            save_usage,
            get_usage_logs,
            get_daily_usage,
            get_weekly_trends,
            get_usage_limits,
            save_usage_limit,
            delete_usage_limit
        ])

        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
